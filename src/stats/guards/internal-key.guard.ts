import {
  Injectable,
  CanActivate,
  ExecutionContext,
  UnauthorizedException,
  Logger,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

/**
 * Internal Key Guard
 *
 * Validates X-Worker-Key header for internal service-to-service communication.
 * Used to protect /internal/* routes from unauthorized access.
 */
@Injectable()
export class InternalKeyGuard implements CanActivate {
  private readonly logger = new Logger(InternalKeyGuard.name);

  constructor(private readonly configService: ConfigService) {}

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest() as {
      headers: Record<string, string | string[] | undefined>;
    };
    // HTTP headers are case-insensitive, but Express/NestJS lowercases them
    const providedKey =
      (request.headers['x-worker-key'] as string | undefined) ||
      (request.headers['X-Worker-Key'] as string | undefined);

    const expectedKey =
      this.configService.get<string>('worker.internalKey') ||
      process.env.WORKER_INTERNAL_KEY;

    if (!expectedKey) {
      throw new UnauthorizedException(
        'Worker internal key not configured on server',
      );
    }

    if (!providedKey || providedKey !== expectedKey) {
      this.logger.warn(
        `Invalid worker key attempt. Expected: ${expectedKey.substring(0, 4)}..., Got: ${providedKey ? providedKey.substring(0, 4) + '...' : 'missing'}`,
      );
      throw new UnauthorizedException('Invalid or missing worker internal key');
    }

    return true;
  }
}
