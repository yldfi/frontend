import { NextRequest, NextResponse } from "next/server";

export const dynamic = "force-dynamic";

// Only enabled in development with DEBUG_RPC_URL configured
const DEBUG_RPC_URL = process.env.DEBUG_RPC_URL || "";
const DEBUG_RPC_AUTH = process.env.DEBUG_RPC_AUTH || "";
const IS_DEV = process.env.NODE_ENV !== "production";

interface TraceCall {
  error?: string;
  revertReason?: string;
  to?: string;
  input?: string;
  calls?: TraceCall[];
}

interface TraceResult {
  error?: string;
  revertReason?: string;
  from?: string;
  to?: string;
  calls?: TraceCall[];
}

function findFailingCall(calls: TraceCall[]): TraceCall | undefined {
  for (const call of calls) {
    if (call.error || call.revertReason) {
      return call;
    }
    if (call.calls) {
      const nested = findFailingCall(call.calls);
      if (nested) return nested;
    }
  }
  return undefined;
}

export async function POST(request: NextRequest) {
  // Security: Only allow in development mode
  if (!IS_DEV) {
    return NextResponse.json(
      { success: false, error: "Debug trace only available in development" },
      { status: 403 }
    );
  }

  // Security: Require DEBUG_RPC_URL to be configured
  if (!DEBUG_RPC_URL) {
    return NextResponse.json(
      { success: false, error: "DEBUG_RPC_URL not configured" },
      { status: 500 }
    );
  }

  // Parse request body
  let body: {
    from?: string;
    to?: string;
    data?: string;
    value?: string;
  };

  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { success: false, error: "Invalid JSON body" },
      { status: 400 }
    );
  }

  if (!body.from || !body.to || !body.data) {
    return NextResponse.json(
      { success: false, error: "Missing required fields: from, to, data" },
      { status: 400 }
    );
  }

  const txParams = {
    from: body.from,
    to: body.to,
    data: body.data,
    value: body.value || "0x0",
  };

  try {
    // First try eth_call
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (DEBUG_RPC_AUTH) {
      headers["Authorization"] = `Basic ${DEBUG_RPC_AUTH}`;
    }

    const ethCallResponse = await fetch(DEBUG_RPC_URL, {
      method: "POST",
      headers,
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "eth_call",
        params: [txParams, "latest"],
      }),
    });

    const ethCallResult = (await ethCallResponse.json()) as {
      error?: { message?: string; code?: number };
      result?: string;
    };

    // If eth_call succeeds, return success
    if (!ethCallResult.error) {
      return NextResponse.json({
        success: true,
        ethCallSuccess: true,
        result: ethCallResult.result,
      });
    }

    // eth_call failed, run debug_traceCall for more details
    console.log("[Debug Trace API] eth_call FAILED:", ethCallResult.error);

    const traceResponse = await fetch(DEBUG_RPC_URL, {
      method: "POST",
      headers,
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 2,
        method: "debug_traceCall",
        params: [txParams, "latest", { tracer: "callTracer" }],
      }),
    });

    const traceResult = (await traceResponse.json()) as {
      result?: TraceResult;
      error?: { message?: string };
    };

    // Extract key debugging info
    const debugInfo: {
      ethCallError: { message?: string; code?: number };
      trace?: {
        error?: string;
        revertReason?: string;
        from?: string;
        to?: string;
      };
      failingCall?: {
        to?: string;
        error?: string;
        revertReason?: string;
        functionSelector?: string;
      };
      fullTrace?: TraceResult;
    } = {
      ethCallError: ethCallResult.error,
    };

    if (traceResult.result) {
      const trace = traceResult.result;
      debugInfo.trace = {
        error: trace.error,
        revertReason: trace.revertReason,
        from: trace.from,
        to: trace.to,
      };

      // Find the specific failing call
      if (trace.calls) {
        const failingCall = findFailingCall(trace.calls);
        if (failingCall) {
          debugInfo.failingCall = {
            to: failingCall.to,
            error: failingCall.error,
            revertReason: failingCall.revertReason,
            functionSelector: failingCall.input?.slice(0, 10),
          };
        }
      }

      // Include full trace for detailed analysis
      debugInfo.fullTrace = trace;
    } else if (traceResult.error) {
      console.log("[Debug Trace API] Trace error:", traceResult.error);
    }

    return NextResponse.json({
      success: true,
      ethCallSuccess: false,
      debugInfo,
    });
  } catch (error) {
    console.log(
      "[Debug Trace API] Error:",
      error instanceof Error ? error.message : error
    );
    return NextResponse.json(
      {
        success: false,
        error: error instanceof Error ? error.message : "Unknown error",
      },
      { status: 500 }
    );
  }
}

// GET for checking if debug trace is available
export async function GET() {
  return NextResponse.json({
    available: IS_DEV && Boolean(DEBUG_RPC_URL),
    isDev: IS_DEV,
    hasDebugRpc: Boolean(DEBUG_RPC_URL),
  });
}
