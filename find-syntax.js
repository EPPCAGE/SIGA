const fs = require('node:fs');
const html = fs.readFileSync('index.html','utf-8');
const re = /<script(?![^>]*\bsrc\b)[^>]*>([\s\S]*?)<\/script>/g;
let m, biggest='';
while((m=re.exec(html))!==null){ if(m[1].length>biggest.length) biggest=m[1]; }
const lines = biggest.split('\n');
console.log('Total lines:', lines.length);

// Conta parênteses linha a linha ignorando strings simples e comentários de linha
let depth=0;
const extras=[];
for(let i=0;i<lines.length;i++){
  const l=lines[i];
  let inStr=false, strC='', j=0;
  while(j<l.length){
    const c=l[j];
    if(inStr){
      if(c===strC && (j===0||l[j-1]!=='\\')) inStr=false;
    } else if(c==='/' && l[j+1]==='/') {
      break; // line comment
    } else if(c==='"'||c==="'"||c==='`'){
      inStr=true; strC=c;
    } else if(c==='(') {
      depth++;
    } else if(c===')') {
      depth--;
      if(depth<0){
        extras.push({line:i+1, depth, content:l.substring(0,120)});
        depth=0;
      }
    }
    j++;
  }
}
console.log('Final paren depth:', depth);
console.log('Extra ) found:');
extras.forEach(x=>console.log('  line',x.line,':',x.content));
if(extras.length===0 && depth!==0) console.log('Unmatched opens, depth=', depth);
