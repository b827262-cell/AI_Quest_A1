export function displayBrand(value: string): string {
  return !value.trim() || value === "iBrain 智匯" || value === "AI-SmartBook" ? "iBrain AI" : value;
}
