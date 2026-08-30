import mongoose, { Schema, type InferSchemaType } from 'mongoose';

export const CATEGORIES = [
  'rates',
  'macro',
  'equities',
  'energy',
  'fx',
  'other_financial',
] as const;

export type FecCategory = (typeof CATEGORIES)[number];
export type FecVenue = 'kalshi' | 'polymarket';

const fecMarketSchema = new Schema(
  {
    venue: { type: String, enum: ['kalshi', 'polymarket'], required: true, index: true },
    externalId: { type: String, required: true, index: true },
    title: { type: String, required: true, index: 'text' },
    category: {
      type: String,
      enum: CATEGORIES,
      required: true,
      index: true,
    },
    yesPrice: { type: Number, required: true },
    volume: { type: Number, default: 0 },
    liquidity: { type: Number, default: 0 },
    closesAt: { type: Date },
    url: { type: String, default: '' },
    seriesTicker: { type: String, default: '' },
    matchGroupId: { type: String, default: '', index: true },
    matchTokens: { type: [String], default: [] },
    asOf: { type: Date, required: true, index: true },
    meta: { type: Schema.Types.Mixed, default: {} },
  },
  { timestamps: true }
);

fecMarketSchema.index({ venue: 1, externalId: 1 }, { unique: true });

export type FecMarketDoc = InferSchemaType<typeof fecMarketSchema> & {
  _id: mongoose.Types.ObjectId;
};

export const FecMarket = mongoose.model('FecMarket', fecMarketSchema);
