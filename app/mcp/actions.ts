"use server";
import {
  createClient,
  executeRequest,
  listTools,
  removeClient,
} from "./client";
import { MCPClientLogger } from "./logger";
import {
  DEFAULT_MCP_CONFIG,
  McpClientData,
  McpConfigData,
  McpRequestMessage,
  ServerConfig,
  ServerStatusResponse,
} from "./types";
import fs from "fs/promises";
import path from "path";
import { getServerSideConfig } from "../config/server";

const logger = new MCPClientLogger("MCP Actions");
const CONFIG_PATH = path.join(process.cwd(), "app/mcp/mcp_config.json");
// Create a singleton for managing client state
class ClientStateManager {
  private static instance: ClientStateManager;
  private clientsMap: Map<string, McpClientData>;
  private initializationPromises: Map<string, Promise<void>>;
  private isInitializing: boolean = false;

  private constructor() {
    this.clientsMap = new Map<string, McpClientData>();
    this.initializationPromises = new Map<string, Promise<void>>();
  }

  public static getInstance(): ClientStateManager {
    if (!ClientStateManager.instance) {
      ClientStateManager.instance = new ClientStateManager();
    }
    return ClientStateManager.instance;
  }

  public getClient(clientId: string): McpClientData | undefined {
    return this.clientsMap.get(clientId);
  }

  public setClient(clientId: string, data: McpClientData): void {
    this.clientsMap.set(clientId, data);
  }

  public deleteClient(clientId: string): void {
    this.clientsMap.delete(clientId);
    this.initializationPromises.delete(clientId);
  }

  public clear(): void {
    this.clientsMap.clear();
    this.initializationPromises.clear();
  }

  public size(): number {
    return this.clientsMap.size;
  }

  public getAllClients(): Map<string, McpClientData> {
    return new Map(this.clientsMap);
  }

  public setInitializationPromise(
    clientId: string,
    promise: Promise<void>,
  ): void {
    this.initializationPromises.set(clientId, promise);
  }

  public getInitializationPromise(clientId: string): Promise<void> | undefined {
    return this.initializationPromises.get(clientId);
  }

  public async waitForInitialization(
    clientId: string,
    timeoutMs: number = 30000,
  ): Promise<void> {
    const promise = this.initializationPromises.get(clientId);
    if (!promise) {
      throw new Error(`No initialization in progress for client ${clientId}`);
    }

    const timeoutPromise = new Promise<void>((_, reject) => {
      setTimeout(
        () =>
          reject(new Error(`Initialization timeout for client ${clientId}`)),
        timeoutMs,
      );
    });

    return Promise.race([promise, timeoutPromise]);
  }

  public setIsInitializing(value: boolean): void {
    this.isInitializing = value;
  }

  public getIsInitializing(): boolean {
    return this.isInitializing;
  }
}

// 获取客户端状态
export async function getClientsStatus(): Promise<
  Record<string, ServerStatusResponse>
> {
  const config = await getMcpConfigFromFile();
  const result: Record<string, ServerStatusResponse> = {};
  const clientStateManager = ClientStateManager.getInstance();

  for (const clientId of Object.keys(config.mcpServers)) {
    const status = clientStateManager.getClient(clientId);
    const serverConfig = config.mcpServers[clientId];

    if (!serverConfig) {
      result[clientId] = { status: "undefined", errorMsg: null };
      continue;
    }

    if (serverConfig.status === "paused") {
      result[clientId] = { status: "paused", errorMsg: null };
      continue;
    }

    if (!status) {
      result[clientId] = { status: "undefined", errorMsg: null };
      continue;
    }

    if (
      status.client === null &&
      status.tools === null &&
      status.errorMsg === null
    ) {
      result[clientId] = { status: "initializing", errorMsg: null };
      continue;
    }

    if (status.errorMsg) {
      result[clientId] = { status: "error", errorMsg: status.errorMsg };
      continue;
    }

    if (status.client) {
      result[clientId] = { status: "active", errorMsg: null };
      continue;
    }

    result[clientId] = { status: "error", errorMsg: "Client not found" };
  }

  return result;
}

// 获取客户端工具
export async function getClientTools(clientId: string) {
  return ClientStateManager.getInstance().getClient(clientId)?.tools ?? null;
}

// 获取可用客户端数量
export async function getAvailableClientsCount() {
  let count = 0;
  const clientStateManager = ClientStateManager.getInstance();
  clientStateManager
    .getAllClients()
    .forEach((client) => !client.errorMsg && count++);
  return count;
}

// 获取所有客户端工具
export async function getAllTools() {
  const result = [];
  const clientStateManager = ClientStateManager.getInstance();
  for (const [clientId, status] of clientStateManager.getAllClients()) {
    result.push({
      clientId,
      tools: status.tools,
    });
  }
  return result;
}

// 初始化单个客户端
async function initializeSingleClient(
  clientId: string,
  serverConfig: ServerConfig,
): Promise<void> {
  const clientStateManager = ClientStateManager.getInstance();

  if (serverConfig.status === "paused") {
    logger.info(`Skipping initialization for paused client [${clientId}]`);
    return;
  }

  logger.info(`Initializing client [${clientId}]...`);

  clientStateManager.setClient(clientId, {
    client: null,
    tools: null,
    errorMsg: null,
  });

  logger.info(`ServerConfig: ${JSON.stringify(serverConfig, null, 2)}`);
  logger.info(
    `ClientsMap: ${JSON.stringify(
      Array.from(clientStateManager.getAllClients().entries()),
      null,
      2,
    )}`,
  );

  const initPromise = new Promise<void>((resolve, reject) => {
    createClient(clientId, serverConfig)
      .then(async (client) => {
        try {
          const tools = await listTools(client);
          logger.info(
            `Supported tools for [${clientId}]: ${JSON.stringify(
              tools,
              null,
              2,
            )}`,
          );
          clientStateManager.setClient(clientId, {
            client,
            tools,
            errorMsg: null,
          });
          logger.success(`Client [${clientId}] initialized successfully`);
          logger.info(
            `ClientsMap Keys: ${Array.from(
              clientStateManager.getAllClients().keys(),
            )}`,
          );
          resolve();
        } catch (error) {
          reject(error);
        }
      })
      .catch((error) => {
        clientStateManager.setClient(clientId, {
          client: null,
          tools: null,
          errorMsg: error instanceof Error ? error.message : String(error),
        });
        logger.error(`Failed to initialize client [${clientId}]: ${error}`);
        reject(error);
      });
  });

  clientStateManager.setInitializationPromise(clientId, initPromise);
  return initPromise;
}

// 初始化系统
export async function initializeMcpSystem() {
  logger.info("MCP Actions starting...");
  const clientStateManager = ClientStateManager.getInstance();

  try {
    // Check if we're already initializing
    if (clientStateManager.getIsInitializing()) {
      logger.info("MCP system initialization already in progress, waiting...");
      // Wait for all current initialization promises
      const promises = Array.from(clientStateManager.getAllClients().keys())
        .map((clientId) =>
          clientStateManager.getInitializationPromise(clientId),
        )
        .filter((p): p is Promise<void> => p !== undefined);

      if (promises.length > 0) {
        await Promise.all(promises);
      }
      return;
    }

    // If we have active clients and no initialization is needed, return
    if (
      clientStateManager.size() > 0 &&
      Array.from(clientStateManager.getAllClients().values()).every(
        (client) => client.client !== null,
      )
    ) {
      logger.info("MCP system already initialized and active, skipping...");
      return;
    }

    // Start initialization
    clientStateManager.setIsInitializing(true);

    try {
      // Clear existing state
      clientStateManager.clear();

      const config = await getMcpConfigFromFile();
      const initPromises: Promise<void>[] = [];

      for (const [clientId, serverConfig] of Object.entries(
        config.mcpServers,
      )) {
        initPromises.push(initializeSingleClient(clientId, serverConfig));
      }

      // Wait for all clients to initialize
      await Promise.all(initPromises);
      return config;
    } finally {
      clientStateManager.setIsInitializing(false);
    }
  } catch (error) {
    clientStateManager.setIsInitializing(false);
    logger.error(`Failed to initialize MCP system: ${error}`);
    throw error;
  }
}

// 添加服务器
export async function addMcpServer(clientId: string, config: ServerConfig) {
  try {
    const currentConfig = await getMcpConfigFromFile();
    const isNewServer = !(clientId in currentConfig.mcpServers);

    // 如果是新服务器，设置默认状态为 active
    if (isNewServer && !config.status) {
      config.status = "active";
    }

    const newConfig = {
      ...currentConfig,
      mcpServers: {
        ...currentConfig.mcpServers,
        [clientId]: config,
      },
    };
    await updateMcpConfig(newConfig);

    // 只有新服务器或状态为 active 的服务器才初始化
    if (isNewServer || config.status === "active") {
      await initializeSingleClient(clientId, config);
    }

    return newConfig;
  } catch (error) {
    logger.error(`Failed to add server [${clientId}]: ${error}`);
    throw error;
  }
}

// 暂停服务器
export async function pauseMcpServer(clientId: string) {
  try {
    logger.info(`Pausing server [${clientId}]...`);
    const currentConfig = await getMcpConfigFromFile();
    const serverConfig = currentConfig.mcpServers[clientId];
    if (!serverConfig) {
      throw new Error(`Server ${clientId} not found`);
    }

    // 先更新配置
    const newConfig: McpConfigData = {
      ...currentConfig,
      mcpServers: {
        ...currentConfig.mcpServers,
        [clientId]: {
          ...serverConfig,
          status: "paused",
        },
      },
    };
    await updateMcpConfig(newConfig);

    // 然后关闭客户端
    const client = ClientStateManager.getInstance().getClient(clientId);
    if (client?.client) {
      await removeClient(client.client);
    }
    ClientStateManager.getInstance().deleteClient(clientId);

    return newConfig;
  } catch (error) {
    logger.error(`Failed to pause server [${clientId}]: ${error}`);
    throw error;
  }
}

// 恢复服务器
export async function resumeMcpServer(clientId: string): Promise<void> {
  try {
    const currentConfig = await getMcpConfigFromFile();
    const serverConfig = currentConfig.mcpServers[clientId];
    if (!serverConfig) {
      throw new Error(`Server ${clientId} not found`);
    }

    // 先尝试初始化客户端
    logger.info(`Trying to initialize client [${clientId}]...`);
    try {
      const client = await createClient(clientId, serverConfig);
      const tools = await listTools(client);
      ClientStateManager.getInstance().setClient(clientId, {
        client,
        tools,
        errorMsg: null,
      });
      logger.success(`Client [${clientId}] initialized successfully`);
      logger.info(
        `ClientsMap Keys: ${Array.from(
          ClientStateManager.getInstance().getAllClients().keys(),
        )}`,
      );

      // 初始化成功后更新配置
      const newConfig: McpConfigData = {
        ...currentConfig,
        mcpServers: {
          ...currentConfig.mcpServers,
          [clientId]: {
            ...serverConfig,
            status: "active" as const,
          },
        },
      };
      await updateMcpConfig(newConfig);
    } catch (error) {
      const currentConfig = await getMcpConfigFromFile();
      const serverConfig = currentConfig.mcpServers[clientId];

      // 如果配置中存在该服务器，则更新其状态为 error
      if (serverConfig) {
        serverConfig.status = "error";
        await updateMcpConfig(currentConfig);
      }

      // 初始化失败
      ClientStateManager.getInstance().setClient(clientId, {
        client: null,
        tools: null,
        errorMsg: error instanceof Error ? error.message : String(error),
      });
      logger.error(`Failed to initialize client [${clientId}]: ${error}`);
      throw error;
    }
  } catch (error) {
    logger.error(`Failed to resume server [${clientId}]: ${error}`);
    throw error;
  }
}

// 移除服务器
export async function removeMcpServer(clientId: string) {
  logger.info(`Removing server [${clientId}]...`);
  try {
    const currentConfig = await getMcpConfigFromFile();
    const { [clientId]: _, ...rest } = currentConfig.mcpServers;
    const newConfig = {
      ...currentConfig,
      mcpServers: rest,
    };
    await updateMcpConfig(newConfig);

    // 关闭并移除客户端
    const client = ClientStateManager.getInstance().getClient(clientId);
    if (client?.client) {
      await removeClient(client.client);
    }
    ClientStateManager.getInstance().deleteClient(clientId);

    return newConfig;
  } catch (error) {
    logger.error(`Failed to remove server [${clientId}]: ${error}`);
    throw error;
  }
}

// 重启所有客户端
export async function restartAllClients() {
  logger.info("Restarting all clients...");
  try {
    // 关闭所有客户端
    const clientStateManager = ClientStateManager.getInstance();
    for (const client of clientStateManager.getAllClients().values()) {
      if (client.client) {
        await removeClient(client.client);
      }
    }

    // 清空状态
    clientStateManager.clear();

    // 重新初始化
    const config = await getMcpConfigFromFile();
    for (const [clientId, serverConfig] of Object.entries(config.mcpServers)) {
      await initializeSingleClient(clientId, serverConfig);
    }
    // output the clientsmap keys
    logger.info(
      `ClientsMap Keys: ${Array.from(
        ClientStateManager.getInstance().getAllClients().keys(),
      )}`,
    );
    return config;
  } catch (error) {
    logger.error(`Failed to restart clients: ${error}`);
    throw error;
  }
}

// 执行 MCP 请求
export async function executeMcpAction(
  clientId: string,
  request: McpRequestMessage,
) {
  logger.info(`Executing request for [${clientId}]`);
  logger.info(`Request: ${JSON.stringify(request, null, 2)}`);

  const clientStateManager = ClientStateManager.getInstance();
  logger.info(
    `ClientsMap Keys: ${Array.from(clientStateManager.getAllClients().keys())}`,
  );

  try {
    // Check if we need to initialize
    let client = clientStateManager.getClient(clientId);
    if (!client?.client && !clientStateManager.getIsInitializing()) {
      logger.info(
        `Client ${clientId} not found, attempting to initialize MCP system...`,
      );
      await initializeMcpSystem();
    }

    // Wait for any ongoing initialization
    const initPromise = clientStateManager.getInitializationPromise(clientId);
    if (initPromise) {
      logger.info(
        `Waiting for client [${clientId}] initialization to complete...`,
      );
      await clientStateManager.waitForInitialization(clientId);
    }

    // Get the client again after initialization
    client = clientStateManager.getClient(clientId);
    if (!client?.client) {
      throw new Error(
        `Client ${clientId} not found or not properly initialized`,
      );
    }

    logger.info(`Executing request for [${clientId}]`);
    return await executeRequest(client.client, request);
  } catch (error) {
    logger.error(`Failed to execute request for [${clientId}]: ${error}`);
    throw error;
  }
}

// 获取 MCP 配置文件
export async function getMcpConfigFromFile(): Promise<McpConfigData> {
  try {
    const configStr = await fs.readFile(CONFIG_PATH, "utf-8");
    return JSON.parse(configStr);
  } catch (error) {
    logger.error(`Failed to load MCP config, using default config: ${error}`);
    return DEFAULT_MCP_CONFIG;
  }
}

// 更新 MCP 配置文件
async function updateMcpConfig(config: McpConfigData): Promise<void> {
  try {
    // 确保目录存在
    await fs.mkdir(path.dirname(CONFIG_PATH), { recursive: true });
    await fs.writeFile(CONFIG_PATH, JSON.stringify(config, null, 2));
  } catch (error) {
    throw error;
  }
}

// 检查 MCP 是否启用
export async function isMcpEnabled() {
  try {
    const serverConfig = getServerSideConfig();
    return serverConfig.enableMcp;
  } catch (error) {
    logger.error(`Failed to check MCP status: ${error}`);
    return false;
  }
}
