import {
  Body,
  Controller,
  Inject,
  Logger,
  Post,
  Headers,
  UnauthorizedException,
  NotImplementedException,
} from '@nestjs/common';
import { ClientProxy } from '@nestjs/microservices';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';

import { AuthService } from '../auth/auth.service.js';
import { AttestationService } from './attestation.service.js';
import {
  AttestationCredentialJSONDto,
  AttestationSelectorDto,
} from './attestation.dto.js';
import { Challenge } from './challenge.schema.js';

@Controller('attestation')
@ApiTags('attestation')
export class AttestationController {
  private readonly logger = new Logger(AttestationController.name);
  constructor(
    @Inject('ACCOUNT_LINK_SERVICE') private client: ClientProxy,
    private attestationService: AttestationService,
    private authService: AuthService,
    @InjectModel(Challenge.name) private challengeModel: Model<Challenge>,
  ) {}
  /**
   * Request Attestation Options
   *
   * Creates a challenge and returns the options for the
   * authentication client to create an attestation
   *
   * @param {AttestationSelectorDto} options - Attestation Selector DTO
   */
  @Post('/request')
  @ApiOperation({ summary: 'Attestation Request' })
  async request(
    @Body() options: AttestationSelectorDto,
  ) {
    this.logger.log(
      `POST /attestation/request for RequestId: ${options?.extensions?.liquid?.requestId}`,
    );
    // Enforce the liquid extension
    if (typeof options?.extensions?.liquid === 'undefined') {
      throw new NotImplementedException({
        reason: 'not_implemented',
        error: 'Liquid extension is required',
      });
    }

    const requestId = options.extensions.liquid.requestId;

    // Request Attestation Options
    const attestationOptions = await this.attestationService.request(options);
    
    // Store challenge in MongoDB keyed by requestId (Stateless Fix)
    await this.challengeModel.findOneAndUpdate(
      { requestId },
      { challenge: attestationOptions.challenge },
      { upsert: true, new: true }
    );

    return attestationOptions;
  }

  /**
   * Validate Attestation Response
   *
   * Validates the attestation response from the authenticator and adds the credential to the user.
   *
   * @param {Headers} headers - Express Request
   * @param {AttestationCredentialJSONDto} body - Attestation Credential JSON DTO
   *
   */
  @Post('/response')
  @ApiOperation({ summary: 'Attestation Response' })
  async response(
    @Headers() headers: Record<string, any>,
    @Body()
    body: AttestationCredentialJSONDto,
  ) {
    this.logger.log(`POST /attestation/response`);
    
    const requestId = body?.clientExtensionResults?.liquid?.requestId;
    if (!requestId) {
        throw new UnauthorizedException({
          reason: 'unauthorized',
          error: 'RequestId not found in response',
        });
    }

    // Retrieve challenge from MongoDB (Stateless Fix)
    const storedChallenge = await this.challengeModel.findOne({ requestId });
    const expectedChallenge = storedChallenge?.challenge;

    // This request should only be called after a request
    if (typeof expectedChallenge !== 'string') {
      throw new UnauthorizedException({
        reason: 'unauthorized',
        error: 'Challenge not found or expired',
      });
    }

    // Verify the Credential and Liquid Extension
    const credential = await this.attestationService
      .response(expectedChallenge, headers['user-agent'], body)
      .catch((e) => {
        this.logger.error(e);
        throw new UnauthorizedException({
          reason: 'unauthorized',
          error: 'User verification failed',
        });
      });

    const username = body.clientExtensionResults.liquid.address;
    // Initialize a new user if it doesn't exist
    await this.authService.init(username);
    // Add the new credential to the user
    const user = await this.authService.addCredential(username, credential);

    // Cleanup Challenge
    await this.challengeModel.deleteOne({ requestId });

    // Handle Liquid Extension
    this.client.emit<string>('auth', {
      requestId: body?.clientExtensionResults?.liquid?.requestId,
      wallet: user.wallet,
      credId: credential.credId,
      sessionId: requestId, // Use requestId as session identifier for stateless flow
    });

    return user;
  }
}

