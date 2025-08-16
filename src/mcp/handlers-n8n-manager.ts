import { N8nApiClient } from '../services/n8n-api-client';
import { getN8nApiConfig } from '../config/n8n-api';
import { 
  Workflow, 
  WorkflowNode, 
  WorkflowConnection,
  ExecutionStatus,
  WebhookRequest,
  McpToolResponse 
} from '../types/n8n-api';
import { 
  validateWorkflowStructure, 
  hasWebhookTrigger,
  getWebhookUrl 
} from '../services/n8n-validation';
import { 
  N8nApiError, 
  N8nNotFoundError,
  getUserFriendlyErrorMessage 
} from '../utils/n8n-errors';
import { logger } from '../utils/logger';
import { z } from 'zod';
import { WorkflowValidator } from '../services/workflow-validator';
import { EnhancedConfigValidator } from '../services/enhanced-config-validator';
import { NodeRepository } from '../database/node-repository';

// 백엔드 API 호출 함수 (API 키 기반 인증)
async function registerWorkflowInBackend(userApiKey: string, n8nWorkflowId: string, workflowName: string): Promise<void> {
  const backendUrl = process.env.BACKEND_API_URL || 'http://localhost:8000';
  
  console.log(`[MCP DEBUG] 백엔드에 워크플로우 등록 시도: ${backendUrl}/api/workflows`);
  console.log(`[MCP DEBUG] API 키: ${userApiKey ? userApiKey.substring(0, 8) + '...' : '없음'}`);
  console.log(`[MCP DEBUG] n8n 워크플로우 ID: ${n8nWorkflowId}`);
  
  try {
    const response = await fetch(`${backendUrl}/api/workflows`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-API-Key': userApiKey
      },
      body: JSON.stringify({
        workflow_id: n8nWorkflowId,
        name: workflowName
      })
    });

    console.log(`[MCP DEBUG] 백엔드 응답 상태: ${response.status} ${response.statusText}`);

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({ detail: 'Unknown error' }));
      console.log(`[MCP DEBUG] 백엔드 에러 응답:`, errorData);
      const detail = (errorData as any)?.detail || response.statusText;
      throw new Error(`Backend API error: ${detail}`);
    }
    
    const successData = await response.json();
    console.log(`[MCP DEBUG] 백엔드 등록 성공:`, successData);
  } catch (error) {
    console.log(`[MCP DEBUG] 백엔드 등록 실패:`, error);
    logger.error('Failed to register workflow in backend:', error);
    // 백엔드 등록 실패해도 n8n 워크플로우는 성공적으로 생성되었으므로 에러를 던지지 않음
    // 대신 로그만 남김
  }
}

// 백엔드 워크플로우 소유권 확인 함수
async function verifyWorkflowOwnership(userApiKey: string, workflowId: string): Promise<boolean> {
  const backendUrl = process.env.BACKEND_API_URL || 'http://localhost:8000';
  
  console.log(`[MCP DEBUG] 백엔드에 워크플로우 소유권 확인 요청: ${backendUrl}/api/workflows/verify`);
  console.log(`[MCP DEBUG] API 키: ${userApiKey ? userApiKey.substring(0, 8) + '...' : '없음'}`);
  console.log(`[MCP DEBUG] 워크플로우 ID: ${workflowId}`);
  
  try {
    const response = await fetch(`${backendUrl}/api/workflows/verify`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-API-Key': userApiKey
      },
      body: JSON.stringify({
        workflow_id: workflowId
      })
    });

    console.log(`[MCP DEBUG] 백엔드 응답 상태: ${response.status} ${response.statusText}`);

    if (!response.ok) {
      console.log(`[MCP DEBUG] 백엔드 소유권 확인 실패: ${response.status}`);
      return false;
    }
    
    const result = await response.json() as { verified?: boolean };
    console.log(`[MCP DEBUG] 백엔드 소유권 확인 결과:`, result);
    return result.verified === true;
  } catch (error) {
    console.log(`[MCP DEBUG] 백엔드 소유권 확인 오류:`, error);
    return false;
  }
}

// 백엔드 워크플로우 삭제 함수
async function deleteWorkflowInBackend(userApiKey: string, workflowId: string): Promise<boolean> {
  const backendUrl = process.env.BACKEND_API_URL || 'http://localhost:8000';
  
  console.log(`[MCP DEBUG] 백엔드에 워크플로우 삭제 요청: ${backendUrl}/api/workflows/delete`);
  console.log(`[MCP DEBUG] API 키: ${userApiKey ? userApiKey.substring(0, 8) + '...' : '없음'}`);
  console.log(`[MCP DEBUG] 워크플로우 ID: ${workflowId}`);
  
  try {
    const response = await fetch(`${backendUrl}/api/workflows/delete`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-API-Key': userApiKey
      },
      body: JSON.stringify({
        workflow_id: workflowId
      })
    });

    console.log(`[MCP DEBUG] 백엔드 응답 상태: ${response.status} ${response.statusText}`);

    if (!response.ok) {
      console.log(`[MCP DEBUG] 백엔드 워크플로우 삭제 실패: ${response.status}`);
      return false;
    }
    
    const result = await response.json() as { deleted?: boolean };
    console.log(`[MCP DEBUG] 백엔드 워크플로우 삭제 결과:`, result);
    return result.deleted === true;
  } catch (error) {
    console.log(`[MCP DEBUG] 백엔드 워크플로우 삭제 오류:`, error);
    return false;
  }
}

// Singleton n8n API client instance
let apiClient: N8nApiClient | null = null;
let lastConfigUrl: string | null = null;

// Get or create API client (with lazy config loading)
export function getN8nApiClient(): N8nApiClient | null {
  const config = getN8nApiConfig();
  
  if (!config) {
    if (apiClient) {
      logger.info('n8n API configuration removed, clearing client');
      apiClient = null;
      lastConfigUrl = null;
    }
    return null;
  }
  
  // Check if config has changed
  if (!apiClient || lastConfigUrl !== config.baseUrl) {
    logger.info('n8n API client initialized', { url: config.baseUrl });
    apiClient = new N8nApiClient(config);
    lastConfigUrl = config.baseUrl;
  }
  
  return apiClient;
}

// Helper to ensure API is configured
function ensureApiConfigured(): N8nApiClient {
  const client = getN8nApiClient();
  if (!client) {
    throw new Error('n8n API not configured. Please set N8N_API_URL and N8N_API_KEY environment variables.');
  }
  return client;
}

// Zod schemas for input validation
const createWorkflowSchema = z.object({
  name: z.string(),
  nodes: z.array(z.any()),
  connections: z.union([
    z.record(z.any()), // 객체로 직접 전달된 경우
    z.string().transform((str, ctx) => { // JSON 문자열로 전달된 경우
      try {
        return JSON.parse(str);
      } catch (error) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'connections must be a valid JSON object or object',
        });
        return z.NEVER;
      }
    })
  ]),
  api_key: z.string(), // 사용자 API 키 추가
  settings: z.object({
    executionOrder: z.enum(['v0', 'v1']).optional(),
    timezone: z.string().optional(),
    saveDataErrorExecution: z.enum(['all', 'none']).optional(),
    saveDataSuccessExecution: z.enum(['all', 'none']).optional(),
    saveManualExecutions: z.boolean().optional(),
    saveExecutionProgress: z.boolean().optional(),
    executionTimeout: z.number().optional(),
    errorWorkflow: z.string().optional(),
  }).optional(),
});

const updateWorkflowSchema = z.object({
  id: z.string(),
  api_key: z.string(),
  name: z.string().optional(),
  nodes: z.array(z.any()).optional(),
  connections: z.record(z.any()).optional(),
  settings: z.any().optional(),
});

const listWorkflowsSchema = z.object({
  api_key: z.string(),
  limit: z.number().min(1).max(100).optional(),
  cursor: z.string().optional(),
  active: z.boolean().optional(),
  tags: z.array(z.string()).optional(),
  projectId: z.string().optional(),
  excludePinnedData: z.boolean().optional(),
});

const validateWorkflowSchema = z.object({
  id: z.string(),
  options: z.object({
    validateNodes: z.boolean().optional(),
    validateConnections: z.boolean().optional(),
    validateExpressions: z.boolean().optional(),
    profile: z.enum(['minimal', 'runtime', 'ai-friendly', 'strict']).optional(),
  }).optional(),
});

const triggerWebhookSchema = z.object({
  webhookUrl: z.string().url(),
  httpMethod: z.enum(['GET', 'POST', 'PUT', 'DELETE']).optional(),
  data: z.record(z.unknown()).optional(),
  headers: z.record(z.string()).optional(),
  waitForResponse: z.boolean().optional(),
});

const listExecutionsSchema = z.object({
  limit: z.number().min(1).max(100).optional(),
  cursor: z.string().optional(),
  workflowId: z.string().optional(),
  projectId: z.string().optional(),
  status: z.enum(['success', 'error', 'waiting']).optional(),
  includeData: z.boolean().optional(),
});

// Workflow Management Handlers

export async function handleCreateWorkflow(args: unknown): Promise<McpToolResponse> {
  try {
    const client = ensureApiConfigured();
    const input = createWorkflowSchema.parse(args);
    const { api_key, ...workflowData } = input;
    
    // Validate workflow structure
    const errors = validateWorkflowStructure(workflowData);
    if (errors.length > 0) {
      return {
        success: false,
        error: 'Workflow validation failed',
        details: { errors }
      };
    }
    
    // Create workflow in n8n
    const workflow = await client.createWorkflow(workflowData);
    
    // Register workflow in backend database
    if (workflow.id) {
      await registerWorkflowInBackend(api_key, workflow.id, workflow.name || 'Untitled Workflow');
    } else {
      console.log(`[MCP DEBUG] 워크플로우 ID가 없어서 백엔드 등록을 건너뜁니다`);
    }
    
    return {
      success: true,
      data: workflow,
      message: `Workflow "${workflow.name}" created successfully with ID: ${workflow.id}`
    };
  } catch (error) {
    if (error instanceof z.ZodError) {
      return {
        success: false,
        error: 'Invalid input',
        details: { errors: error.errors }
      };
    }
    
    if (error instanceof N8nApiError) {
      return {
        success: false,
        error: getUserFriendlyErrorMessage(error),
        code: error.code,
        details: error.details as Record<string, unknown> | undefined
      };
    }
    
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error occurred'
    };
  }
}

export async function handleGetWorkflow(args: unknown): Promise<McpToolResponse> {
  try {
    const client = ensureApiConfigured();
    const { id } = z.object({ id: z.string() }).parse(args);
    
    const workflow = await client.getWorkflow(id);
    
    return {
      success: true,
      data: workflow
    };
  } catch (error) {
    if (error instanceof z.ZodError) {
      return {
        success: false,
        error: 'Invalid input',
        details: { errors: error.errors }
      };
    }
    
    if (error instanceof N8nApiError) {
      return {
        success: false,
        error: getUserFriendlyErrorMessage(error),
        code: error.code
      };
    }
    
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error occurred'
    };
  }
}

export async function handleGetWorkflowDetails(args: unknown): Promise<McpToolResponse> {
  try {
    const client = ensureApiConfigured();
    const { id } = z.object({ id: z.string() }).parse(args);
    
    const workflow = await client.getWorkflow(id);
    
    // Get recent executions for this workflow
    const executions = await client.listExecutions({
      workflowId: id,
      limit: 10
    });
    
    // Calculate execution statistics
    const stats = {
      totalExecutions: executions.data.length,
      successCount: executions.data.filter(e => e.status === ExecutionStatus.SUCCESS).length,
      errorCount: executions.data.filter(e => e.status === ExecutionStatus.ERROR).length,
      lastExecutionTime: executions.data[0]?.startedAt || null
    };
    
    return {
      success: true,
      data: {
        workflow,
        executionStats: stats,
        hasWebhookTrigger: hasWebhookTrigger(workflow),
        webhookPath: getWebhookUrl(workflow)
      }
    };
  } catch (error) {
    if (error instanceof z.ZodError) {
      return {
        success: false,
        error: 'Invalid input',
        details: { errors: error.errors }
      };
    }
    
    if (error instanceof N8nApiError) {
      return {
        success: false,
        error: getUserFriendlyErrorMessage(error),
        code: error.code
      };
    }
    
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error occurred'
    };
  }
}

export async function handleGetWorkflowStructure(args: unknown): Promise<McpToolResponse> {
  try {
    const client = ensureApiConfigured();
    const { id } = z.object({ id: z.string() }).parse(args);
    
    const workflow = await client.getWorkflow(id);
    
    // Simplify nodes to just essential structure
    const simplifiedNodes = workflow.nodes.map(node => ({
      id: node.id,
      name: node.name,
      type: node.type,
      position: node.position,
      disabled: node.disabled || false
    }));
    
    return {
      success: true,
      data: {
        id: workflow.id,
        name: workflow.name,
        active: workflow.active,
        nodes: simplifiedNodes,
        connections: workflow.connections,
        nodeCount: workflow.nodes.length,
        connectionCount: Object.keys(workflow.connections).length
      }
    };
  } catch (error) {
    if (error instanceof z.ZodError) {
      return {
        success: false,
        error: 'Invalid input',
        details: { errors: error.errors }
      };
    }
    
    if (error instanceof N8nApiError) {
      return {
        success: false,
        error: getUserFriendlyErrorMessage(error),
        code: error.code
      };
    }
    
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error occurred'
    };
  }
}

export async function handleGetWorkflowMinimal(args: unknown): Promise<McpToolResponse> {
  try {
    const client = ensureApiConfigured();
    const { id } = z.object({ id: z.string() }).parse(args);
    
    const workflow = await client.getWorkflow(id);
    
    return {
      success: true,
      data: {
        id: workflow.id,
        name: workflow.name,
        active: workflow.active,
        tags: workflow.tags || [],
        createdAt: workflow.createdAt,
        updatedAt: workflow.updatedAt
      }
    };
  } catch (error) {
    if (error instanceof z.ZodError) {
      return {
        success: false,
        error: 'Invalid input',
        details: { errors: error.errors }
      };
    }
    
    if (error instanceof N8nApiError) {
      return {
        success: false,
        error: getUserFriendlyErrorMessage(error),
        code: error.code
      };
    }
    
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error occurred'
    };
  }
}

export async function handleUpdateWorkflow(args: unknown): Promise<McpToolResponse> {
  try {
    const client = ensureApiConfigured();
    const input = updateWorkflowSchema.parse(args);
    const { id, api_key, ...updateData } = input;
    
    // 워크플로우 소유권 확인
    const isVerified = await verifyWorkflowOwnership(api_key, id);
    if (!isVerified) {
      return {
        success: false,
        error: '본인의 워크플로우가 아니라 업데이트 할 수 없습니다.',
        details: { workflowId: id }
      };
    }
    
    // If nodes/connections are being updated, validate the structure
    if (updateData.nodes || updateData.connections) {
      // Fetch current workflow if only partial update
      let fullWorkflow = updateData as Partial<Workflow>;
      
      if (!updateData.nodes || !updateData.connections) {
        const current = await client.getWorkflow(id);
        fullWorkflow = {
          ...current,
          ...updateData
        };
      }
      
      const errors = validateWorkflowStructure(fullWorkflow);
      if (errors.length > 0) {
        return {
          success: false,
          error: 'Workflow validation failed',
          details: { errors }
        };
      }
    }
    
    // Update workflow
    const workflow = await client.updateWorkflow(id, updateData);
    
    return {
      success: true,
      data: workflow,
      message: `Workflow "${workflow.name}" updated successfully`
    };
  } catch (error) {
    if (error instanceof z.ZodError) {
      return {
        success: false,
        error: 'Invalid input',
        details: { errors: error.errors }
      };
    }
    
    if (error instanceof N8nApiError) {
      return {
        success: false,
        error: getUserFriendlyErrorMessage(error),
        code: error.code,
        details: error.details as Record<string, unknown> | undefined
      };
    }
    
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error occurred'
    };
  }
}

export async function handleDeleteWorkflow(args: unknown): Promise<McpToolResponse> {
  try {
    const client = ensureApiConfigured();
    const { id, api_key } = z.object({ 
      id: z.string(),
      api_key: z.string()
    }).parse(args);
    
    // 백엔드에서 워크플로우 소유권 확인 및 삭제
    const isDeleted = await deleteWorkflowInBackend(api_key, id);
    if (!isDeleted) {
      return {
        success: false,
        error: '본인의 워크플로우가 아니라 삭제할 수 없습니다.',
        details: { workflowId: id }
      };
    }
    
    // 백엔드에서 삭제 성공했으면 n8n에서도 삭제
    await client.deleteWorkflow(id);
    
    return {
      success: true,
      message: `Workflow ${id} deleted successfully`
    };
  } catch (error) {
    if (error instanceof z.ZodError) {
      return {
        success: false,
        error: 'Invalid input',
        details: { errors: error.errors }
      };
    }
    
    if (error instanceof N8nApiError) {
      return {
        success: false,
        error: getUserFriendlyErrorMessage(error),
        code: error.code
      };
    }
    
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error occurred'
    };
  }
}

// 백엔드 사용자 워크플로우 목록 조회 함수
async function getUserWorkflowsFromBackend(userApiKey: string, limit?: number): Promise<{id: string, name: string}[]> {
  const backendUrl = process.env.BACKEND_API_URL || 'http://localhost:8000';
  
  console.log(`[MCP DEBUG] 백엔드에 사용자 워크플로우 목록 요청: ${backendUrl}/api/workflows`);
  console.log(`[MCP DEBUG] API 키: ${userApiKey ? userApiKey.substring(0, 8) + '...' : '없음'}`);
  
  try {
    const response = await fetch(`${backendUrl}/api/workflows`, {
      method: 'GET',
      headers: {
        'Content-Type': 'application/json',
        'X-API-Key': userApiKey
      }
    });

    console.log(`[MCP DEBUG] 백엔드 응답 상태: ${response.status} ${response.statusText}`);

    if (!response.ok) {
      console.log(`[MCP DEBUG] 백엔드 워크플로우 목록 조회 실패: ${response.status}`);
      return [];
    }
    
    const result = await response.json() as { workflows?: {workflow_id: string, title: string}[] };
    console.log(`[MCP DEBUG] 백엔드 워크플로우 목록 조회 결과:`, result);
    
    // 백엔드 형식을 n8n 형식으로 변환
    const workflows = (result.workflows || []).map(wf => ({
      id: wf.workflow_id,
      name: wf.title
    }));
    
    // limit 적용
    return limit ? workflows.slice(0, limit) : workflows;
  } catch (error) {
    console.log(`[MCP DEBUG] 백엔드 워크플로우 목록 조회 오류:`, error);
    return [];
  }
}

export async function handleListWorkflows(args: unknown): Promise<McpToolResponse> {
  try {
    const input = listWorkflowsSchema.parse(args || {});
    const { api_key, tags, limit, ...otherParams } = input;
    
    // 태그가 있으면 n8n에서 표준 워크플로우 조회
    if (tags && tags.length > 0) {
      console.log(`[MCP DEBUG] 태그가 있어서 n8n에서 표준 워크플로우 조회: ${tags}`);
      const client = ensureApiConfigured();
      
      const response = await client.listWorkflows({
        limit: limit || 100,
        cursor: otherParams.cursor,
        active: otherParams.active,
        tags: tags.join(','), // 배열을 쉼표로 구분된 문자열로 변환
        projectId: otherParams.projectId,
        excludePinnedData: otherParams.excludePinnedData ?? true
      } as any); // 타입 에러 방지를 위해 any로 캐스팅
      
      // Strip down workflows to only id and name
      const minimalWorkflows = response.data.map(workflow => ({
        id: workflow.id,
        name: workflow.name
      }));

      return {
        success: true,
        data: {
          workflows: minimalWorkflows,
          returned: minimalWorkflows.length,
          nextCursor: response.nextCursor,
          hasMore: !!response.nextCursor,
          ...(response.nextCursor ? { 
            _note: "More workflows available. Use cursor to get next page." 
          } : {})
        }
      };
    } 
    // 태그가 없으면 백엔드에서 사용자 워크플로우 조회
    else {
      console.log(`[MCP DEBUG] 태그가 없어서 백엔드에서 사용자 워크플로우 조회`);
      const workflows = await getUserWorkflowsFromBackend(api_key, limit);
      
      return {
        success: true,
        data: {
          workflows: workflows,
          returned: workflows.length,
          hasMore: false,
          _note: "User workflows from backend"
        }
      };
    }
  } catch (error) {
    if (error instanceof z.ZodError) {
      return {
        success: false,
        error: 'Invalid input',
        details: { errors: error.errors }
      };
    }
    
    if (error instanceof N8nApiError) {
      return {
        success: false,
        error: getUserFriendlyErrorMessage(error),
        code: error.code
      };
    }
    
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error occurred'
    };
  }
}

export async function handleValidateWorkflow(
  args: unknown, 
  repository: NodeRepository
): Promise<McpToolResponse> {
  try {
    const client = ensureApiConfigured();
    const input = validateWorkflowSchema.parse(args);
    
    // First, fetch the workflow from n8n
    const workflowResponse = await handleGetWorkflow({ id: input.id });
    
    if (!workflowResponse.success) {
      return workflowResponse; // Return the error from fetching
    }
    
    const workflow = workflowResponse.data as Workflow;
    
    // Create validator instance using the provided repository
    const validator = new WorkflowValidator(repository, EnhancedConfigValidator);
    
    // Run validation
    const validationResult = await validator.validateWorkflow(workflow, input.options);
    
    // Format the response (same format as the regular validate_workflow tool)
    const response: any = {
      valid: validationResult.valid,
      workflowId: workflow.id,
      workflowName: workflow.name,
      summary: {
        totalNodes: validationResult.statistics.totalNodes,
        enabledNodes: validationResult.statistics.enabledNodes,
        triggerNodes: validationResult.statistics.triggerNodes,
        validConnections: validationResult.statistics.validConnections,
        invalidConnections: validationResult.statistics.invalidConnections,
        expressionsValidated: validationResult.statistics.expressionsValidated,
        errorCount: validationResult.errors.length,
        warningCount: validationResult.warnings.length
      }
    };
    
    if (validationResult.errors.length > 0) {
      response.errors = validationResult.errors.map(e => ({
        node: e.nodeName || 'workflow',
        message: e.message,
        details: e.details
      }));
    }
    
    if (validationResult.warnings.length > 0) {
      response.warnings = validationResult.warnings.map(w => ({
        node: w.nodeName || 'workflow',
        message: w.message,
        details: w.details
      }));
    }
    
    if (validationResult.suggestions.length > 0) {
      response.suggestions = validationResult.suggestions;
    }
    
    return {
      success: true,
      data: response
    };
  } catch (error) {
    if (error instanceof z.ZodError) {
      return {
        success: false,
        error: 'Invalid input',
        details: { errors: error.errors }
      };
    }
    
    if (error instanceof N8nApiError) {
      return {
        success: false,
        error: getUserFriendlyErrorMessage(error),
        code: error.code
      };
    }
    
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error occurred'
    };
  }
}

// Execution Management Handlers

export async function handleTriggerWebhookWorkflow(args: unknown): Promise<McpToolResponse> {
  try {
    const client = ensureApiConfigured();
    const input = triggerWebhookSchema.parse(args);
    
    const webhookRequest: WebhookRequest = {
      webhookUrl: input.webhookUrl,
      httpMethod: input.httpMethod || 'POST',
      data: input.data,
      headers: input.headers,
      waitForResponse: input.waitForResponse ?? true
    };
    
    const response = await client.triggerWebhook(webhookRequest);
    
    return {
      success: true,
      data: response,
      message: 'Webhook triggered successfully'
    };
  } catch (error) {
    if (error instanceof z.ZodError) {
      return {
        success: false,
        error: 'Invalid input',
        details: { errors: error.errors }
      };
    }
    
    if (error instanceof N8nApiError) {
      return {
        success: false,
        error: getUserFriendlyErrorMessage(error),
        code: error.code,
        details: error.details as Record<string, unknown> | undefined
      };
    }
    
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error occurred'
    };
  }
}

export async function handleGetExecution(args: unknown): Promise<McpToolResponse> {
  try {
    const client = ensureApiConfigured();
    const { id, includeData } = z.object({ 
      id: z.string(),
      includeData: z.boolean().optional()
    }).parse(args);
    
    const execution = await client.getExecution(id, includeData || false);
    
    return {
      success: true,
      data: execution
    };
  } catch (error) {
    if (error instanceof z.ZodError) {
      return {
        success: false,
        error: 'Invalid input',
        details: { errors: error.errors }
      };
    }
    
    if (error instanceof N8nApiError) {
      return {
        success: false,
        error: getUserFriendlyErrorMessage(error),
        code: error.code
      };
    }
    
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error occurred'
    };
  }
}

export async function handleListExecutions(args: unknown): Promise<McpToolResponse> {
  try {
    const client = ensureApiConfigured();
    const input = listExecutionsSchema.parse(args || {});
    
    const response = await client.listExecutions({
      limit: input.limit || 100,
      cursor: input.cursor,
      workflowId: input.workflowId,
      projectId: input.projectId,
      status: input.status as ExecutionStatus | undefined,
      includeData: input.includeData || false
    });
    
    return {
      success: true,
      data: {
        executions: response.data,
        returned: response.data.length,
        nextCursor: response.nextCursor,
        hasMore: !!response.nextCursor,
        ...(response.nextCursor ? { 
          _note: "More executions available. Use cursor to get next page." 
        } : {})
      }
    };
  } catch (error) {
    if (error instanceof z.ZodError) {
      return {
        success: false,
        error: 'Invalid input',
        details: { errors: error.errors }
      };
    }
    
    if (error instanceof N8nApiError) {
      return {
        success: false,
        error: getUserFriendlyErrorMessage(error),
        code: error.code
      };
    }
    
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error occurred'
    };
  }
}

export async function handleDeleteExecution(args: unknown): Promise<McpToolResponse> {
  try {
    const client = ensureApiConfigured();
    const { id } = z.object({ id: z.string() }).parse(args);
    
    await client.deleteExecution(id);
    
    return {
      success: true,
      message: `Execution ${id} deleted successfully`
    };
  } catch (error) {
    if (error instanceof z.ZodError) {
      return {
        success: false,
        error: 'Invalid input',
        details: { errors: error.errors }
      };
    }
    
    if (error instanceof N8nApiError) {
      return {
        success: false,
        error: getUserFriendlyErrorMessage(error),
        code: error.code
      };
    }
    
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error occurred'
    };
  }
}

// System Tools Handlers

export async function handleHealthCheck(): Promise<McpToolResponse> {
  try {
    const client = ensureApiConfigured();
    const health = await client.healthCheck();
    
    // Get MCP version from package.json
    const packageJson = require('../../package.json');
    const mcpVersion = packageJson.version;
    const supportedN8nVersion = packageJson.dependencies?.n8n?.replace(/[^0-9.]/g, '');
    
    return {
      success: true,
      data: {
        status: health.status,
        instanceId: health.instanceId,
        n8nVersion: health.n8nVersion,
        features: health.features,
        apiUrl: getN8nApiConfig()?.baseUrl,
        mcpVersion,
        supportedN8nVersion,
        versionNote: 'AI Agent: Please inform the user to verify their n8n instance version matches or is compatible with the supported version listed above. The n8n API currently does not expose version information, so manual verification is required.'
      }
    };
  } catch (error) {
    if (error instanceof N8nApiError) {
      return {
        success: false,
        error: getUserFriendlyErrorMessage(error),
        code: error.code,
        details: {
          apiUrl: getN8nApiConfig()?.baseUrl,
          hint: 'Check if n8n is running and API is enabled'
        }
      };
    }
    
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error occurred'
    };
  }
}

export async function handleListAvailableTools(): Promise<McpToolResponse> {
  const tools = [
    {
      category: 'Workflow Management',
      tools: [
        { name: 'n8n_create_workflow', description: 'Create new workflows' },
        { name: 'n8n_get_workflow', description: 'Get workflow by ID' },
        { name: 'n8n_get_workflow_details', description: 'Get detailed workflow info with stats' },
        { name: 'n8n_get_workflow_structure', description: 'Get simplified workflow structure' },
        { name: 'n8n_get_workflow_minimal', description: 'Get minimal workflow info' },
        { name: 'n8n_update_workflow', description: 'Update existing workflows' },
        { name: 'n8n_delete_workflow', description: 'Delete workflows' },
        { name: 'n8n_list_workflows', description: 'List workflows with filters' },
        { name: 'n8n_validate_workflow', description: 'Validate workflow from n8n instance' }
      ]
    },
    {
      category: 'Execution Management',
      tools: [
        { name: 'n8n_trigger_webhook_workflow', description: 'Trigger workflows via webhook' },
        { name: 'n8n_get_execution', description: 'Get execution details' },
        { name: 'n8n_list_executions', description: 'List executions with filters' },
        { name: 'n8n_delete_execution', description: 'Delete execution records' }
      ]
    },
    {
      category: 'System',
      tools: [
        { name: 'n8n_health_check', description: 'Check API connectivity' },
        { name: 'n8n_list_available_tools', description: 'List all available tools' }
      ]
    }
  ];
  
  const config = getN8nApiConfig();
  const apiConfigured = config !== null;
  
  return {
    success: true,
    data: {
      tools,
      apiConfigured,
      configuration: config ? {
        apiUrl: config.baseUrl,
        timeout: config.timeout,
        maxRetries: config.maxRetries
      } : null,
      limitations: [
        'Cannot activate/deactivate workflows via API',
        'Cannot execute workflows directly (must use webhooks)',
        'Cannot stop running executions',
        'Tags and credentials have limited API support'
      ]
    }
  };
}

// Handler: n8n_diagnostic
export async function handleDiagnostic(request: any): Promise<McpToolResponse> {
  const verbose = request.params?.arguments?.verbose || false;
  
  // Check environment variables
  const envVars = {
    N8N_API_URL: process.env.N8N_API_URL || null,
    N8N_API_KEY: process.env.N8N_API_KEY ? '***configured***' : null,
    NODE_ENV: process.env.NODE_ENV || 'production',
    MCP_MODE: process.env.MCP_MODE || 'stdio'
  };
  
  // Check API configuration
  const apiConfig = getN8nApiConfig();
  const apiConfigured = apiConfig !== null;
  const apiClient = getN8nApiClient();
  
  // Test API connectivity if configured
  let apiStatus = {
    configured: apiConfigured,
    connected: false,
    error: null as string | null,
    version: null as string | null
  };
  
  if (apiClient) {
    try {
      const health = await apiClient.healthCheck();
      apiStatus.connected = true;
      apiStatus.version = health.n8nVersion || 'unknown';
    } catch (error) {
      apiStatus.error = error instanceof Error ? error.message : 'Unknown error';
    }
  }
  
  // Check which tools are available
  const documentationTools = 22; // Base documentation tools
  const managementTools = apiConfigured ? 16 : 0;
  const totalTools = documentationTools + managementTools;
  
  // Build diagnostic report
  const diagnostic: any = {
    timestamp: new Date().toISOString(),
    environment: envVars,
    apiConfiguration: {
      configured: apiConfigured,
      status: apiStatus,
      config: apiConfig ? {
        baseUrl: apiConfig.baseUrl,
        timeout: apiConfig.timeout,
        maxRetries: apiConfig.maxRetries
      } : null
    },
    toolsAvailability: {
      documentationTools: {
        count: documentationTools,
        enabled: true,
        description: 'Always available - node info, search, validation, etc.'
      },
      managementTools: {
        count: managementTools,
        enabled: apiConfigured,
        description: apiConfigured ? 
          'Management tools are ENABLED - create, update, execute workflows' : 
          'Management tools are DISABLED - configure N8N_API_URL and N8N_API_KEY to enable'
      },
      totalAvailable: totalTools
    },
    troubleshooting: {
      steps: apiConfigured ? [
        'API is configured and should work',
        'If tools are not showing in Claude Desktop:',
        '1. Restart Claude Desktop completely',
        '2. Check if using latest Docker image',
        '3. Verify environment variables are passed correctly',
        '4. Try running n8n_health_check to test connectivity'
      ] : [
        'To enable management tools:',
        '1. Set N8N_API_URL environment variable (e.g., https://your-n8n-instance.com)',
        '2. Set N8N_API_KEY environment variable (get from n8n API settings)',
        '3. Restart the MCP server',
        '4. Management tools will automatically appear'
      ],
      documentation: 'For detailed setup instructions, see: https://github.com/czlonkowski/n8n-mcp?tab=readme-ov-file#n8n-management-tools-optional---requires-api-configuration'
    }
  };
  
  // Add verbose debug info if requested
  if (verbose) {
    diagnostic['debug'] = {
      processEnv: Object.keys(process.env).filter(key => 
        key.startsWith('N8N_') || key.startsWith('MCP_')
      ),
      nodeVersion: process.version,
      platform: process.platform,
      workingDirectory: process.cwd()
    };
  }
  
  return {
    success: true,
    data: diagnostic
  };
}
