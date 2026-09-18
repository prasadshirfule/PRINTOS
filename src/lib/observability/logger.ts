export interface LogContext {
  orderId?: string;
  jobId?: string;
  agentName?: string;
  customerPhone?: string;
  action?: string;
  durationMs?: number;
  [key: string]: unknown;
}

export class Logger {
  private component: string;

  constructor(component: string) {
    this.component = component;
  }

  private format(level: 'INFO' | 'WARN' | 'ERROR' | 'DEBUG', message: string, context?: LogContext): string {
    const timestamp = new Date().toISOString();
    const isProduction = process.env.NODE_ENV === 'production';

    if (isProduction) {
      return JSON.stringify({
        timestamp,
        level,
        component: this.component,
        message,
        ...context,
      });
    }

    const contextStr = context && Object.keys(context).length > 0 ? ` | ${JSON.stringify(context)}` : '';
    return `[${timestamp}] [${level}] [${this.component}] ${message}${contextStr}`;
  }

  public info(message: string, context?: LogContext): void {
    console.log(this.format('INFO', message, context));
  }

  public warn(message: string, context?: LogContext): void {
    console.warn(this.format('WARN', message, context));
  }

  public error(message: string, errorOrContext?: Error | LogContext, context?: LogContext): void {
    if (errorOrContext instanceof Error) {
      const mergedContext = {
        ...context,
        errorMessage: errorOrContext.message,
        stack: errorOrContext.stack,
      };
      console.error(this.format('ERROR', message, mergedContext));
    } else {
      console.error(this.format('ERROR', message, errorOrContext));
    }
  }

  public debug(message: string, context?: LogContext): void {
    if (process.env.DEBUG || process.env.NODE_ENV === 'development') {
      console.log(this.format('DEBUG', message, context));
    }
  }
}

export function createLogger(component: string): Logger {
  return new Logger(component);
}
