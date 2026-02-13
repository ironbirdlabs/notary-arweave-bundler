import { DataItem, Tag } from "@dha-team/arbundles";

export interface ParsedDataItem {
  id: string;
  signatureType: number;
  owner: string;
  target: string | undefined;
  anchor: string | undefined;
  tags: Tag[];
  rawData: Buffer;
  isValid: () => Promise<boolean>;
}

export function parseDataItem(buffer: Buffer): ParsedDataItem {
  const dataItem = new DataItem(buffer);
  return {
    id: dataItem.id,
    signatureType: dataItem.signatureType,
    owner: dataItem.owner,
    target: dataItem.target || undefined,
    anchor: dataItem.anchor || undefined,
    tags: dataItem.tags,
    rawData: dataItem.rawData,
    isValid: () => dataItem.isValid(),
  };
}
