/** Debe coincidir con ServimOS `externalOrderActorEmail` (misma BD compartida). */
export function externalOrderActorEmail(restauranteId: string): string {
  return `pedidos-externos.${restauranteId}@servimos.internal`;
}
