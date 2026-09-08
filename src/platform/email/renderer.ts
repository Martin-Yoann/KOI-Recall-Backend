export class EmailRenderer {
  static render(template: string, variables: Record<string, any>): string {
    let result = template;
    for (const [key, value] of Object.entries(variables)) {
      const sanitizedValue = String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
      result = result.replace(new RegExp(`\\{\\{${key}\\}\\}`, 'g'), sanitizedValue);
    }

    // Fail-Closed: 检查是否有剩余的占位符未渲染
    if (/\{\{[^}]+\}\}/.test(result)) {
      throw new Error(`[Render Error] Unresolved template variables in template`);
    }

    // Compliance Check: 禁止状态词越界
    const forbidden = ['approved', 'eligible', '退款已确认'];
    for (const word of forbidden) {
      if (result.toLowerCase().includes(word.toLowerCase())) {
        throw new Error(`[Compliance Error] Forbidden status wording detected: ${word}`);
      }
    }

    return result;
  }
}
