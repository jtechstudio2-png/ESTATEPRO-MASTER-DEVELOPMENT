'use client';

import { createContext, type ReactNode, useContext } from 'react';

export interface MapConfig {
  /** Self-hosted PMTiles basemap (W-D4); empty = plain background map. */
  tilesUrl: string;
  /** Glyph URL template for labels ({fontstack}/{range}.pbf); empty = no labels. */
  glyphsUrl: string;
}

const Context = createContext<MapConfig>({ tilesUrl: '', glyphsUrl: '' });

export function MapConfigProvider({ value, children }: { value: MapConfig; children: ReactNode }) {
  return <Context.Provider value={value}>{children}</Context.Provider>;
}

export function useMapConfig(): MapConfig {
  return useContext(Context);
}
