import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

@Schema({ timestamps: true })
export class Challenge extends Document {
  @Prop({ required: true, unique: true })
  requestId: string;

  @Prop({ required: true })
  challenge: string;

  @Prop({ default: Date.now, expires: 3600 }) // Expire after 1 hour
  createdAt: Date;
}

export const ChallengeSchema = SchemaFactory.createForClass(Challenge);
