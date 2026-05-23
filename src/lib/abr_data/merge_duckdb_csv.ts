/**
 * settings.lgCodes (RegExp[]) を DuckDB SQL の WHERE 断片に変換する純関数。
 * 空配列なら undefined を返し、呼び出し側で WHERE 句自体を省略させる。
 * RegExp.source 内のシングルクォートは SQL リテラル境界を破壊するので
 * 二重化 ('') してエスケープする (信頼境界外入力扱い)。
 */
export function buildLgCodeWhereClause(
  columnExpr: string,
  patterns: RegExp[],
): string | undefined {
  if (patterns.length === 0) return undefined;
  return patterns
    .map((re) => {
      const escaped = re.source.replace(/'/g, "''");
      return `regexp_matches(${columnExpr}, '${escaped}')`;
    })
    .join(' OR ');
}
