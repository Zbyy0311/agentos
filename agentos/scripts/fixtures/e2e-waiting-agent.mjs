const prompt = process.argv.slice(2).join(' ');

if (prompt.includes('AGENTOS_RESUME_OK')) {
  process.stdout.write('AGENTOS_RESUME_OK：补充信息已收到，验证完成。\n');
  process.exit(0);
}

process.stdout.write('<!-- agentos-waiting-user: {"question":"请补充确定性验收所需的信息"} -->\n');
