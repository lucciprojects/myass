import { Effect } from "./effect";

export interface Preset {
  id: string;
  name: string;
  effects: Effect[];
}