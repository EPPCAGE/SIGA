#!/usr/bin/env python3
"""Fix remaining S3358 nested ternaries in const/let assignments."""
import re
import sys

def split_ternary(expr):
    """Split 'COND ? TRUE : FALSE' at the outermost level."""
    depth = 0
    in_str = None
    i = 0
    q = -1
    while i < len(expr):
        c = expr[i]
        if in_str:
            if c == '\\':
                i += 2
                continue
            if c == in_str:
                in_str = None
        elif c in ('"', "'", '`'):
            in_str = c
        elif c in ('(', '[', '{'):
            depth += 1
        elif c in (')', ']', '}'):
            depth -= 1
        elif c == '?' and depth == 0 and i + 1 < len(expr) and expr[i+1] != '.':
            q = i
            break
        i += 1

    if q < 0:
        return None

    # Find matching colon
    depth = 0
    in_str = None
    i = q + 1
    colon = -1
    while i < len(expr):
        c = expr[i]
        if in_str:
            if c == '\\':
                i += 2
                continue
            if c == in_str:
                in_str = None
        elif c in ('"', "'", '`'):
            in_str = c
        elif c in ('(', '[', '{'):
            depth += 1
        elif c in (')', ']', '}'):
            depth -= 1
        elif c == ':' and depth == 0:
            colon = i
            break
        i += 1

    if colon < 0:
        return None

    cond = expr[:q].strip()
    true_val = expr[q+1:colon].strip()
    false_val = expr[colon+1:].strip()
    return (cond, true_val, false_val)

def is_nested_ternary(expr):
    """Check if the true or false branch of a ternary is itself a ternary."""
    result = split_ternary(expr)
    if not result:
        return False
    _, true_val, false_val = result
    # Check if false_val is a ternary (at depth 0)
    if split_ternary(false_val):
        return True
    # Check if true_val is a ternary (at depth 0) - less common
    if split_ternary(true_val):
        return True
    return False

def make_temp_name(varname):
    """Create a temporary variable name by adding underscore prefix."""
    # If already has __ prefix, use ___; otherwise add _
    if varname.startswith('__'):
        return '_' + varname
    elif varname.startswith('_'):
        return '_' + varname
    else:
        return '_' + varname

def fix_const_let_nested(line):
    """
    Transform:
      [indent]const/let varname = A ? B : C ? D : E;
    Into:
      [indent]const tempname = C ? D : E;
      [indent]const/let varname = A ? B : tempname;
    Returns (new_lines_str, changed) or (line, False).
    """
    m = re.match(r'^(\s*)(const|let)\s+(\w+)\s*=\s*(.+?)\s*;\s*$', line)
    if not m:
        return line, False

    indent = m.group(1)
    kw = m.group(2)
    varname = m.group(3)
    expr = m.group(4)

    result = split_ternary(expr)
    if not result:
        return line, False

    cond, true_val, false_val = result

    # Only handle if false_val is itself a nested ternary
    if not split_ternary(false_val):
        return line, False

    tempname = make_temp_name(varname)
    new_lines = (
        f"{indent}const {tempname} = {false_val};\n"
        f"{indent}{kw} {varname} = {cond} ? {true_val} : {tempname};"
    )
    return new_lines, True

def fix_destructuring_nested(line):
    """
    Transform:
      [indent]const [a, b] = A ? [...] : B ? [...] : [...];
    Into an if-else block.
    """
    m = re.match(r'^(\s*)(const|let)\s+(\[[\w,\s]+\])\s*=\s*(.+?)\s*;\s*$', line)
    if not m:
        return line, False

    indent = m.group(1)
    kw = m.group(2)
    destructure = m.group(3)
    expr = m.group(4)

    # Extract variable names from destructuring
    var_names = [v.strip() for v in destructure.strip('[]').split(',')]

    result = split_ternary(expr)
    if not result:
        return line, False

    cond1, true1, false_expr = result
    result2 = split_ternary(false_expr)
    if not result2:
        return line, False

    cond2, true2, false2 = result2

    def assign_vars(names, arr_str):
        """Parse [a, b] assignment from arr_str like "['alto','Alto']"."""
        return arr_str  # Just use it as-is in destructuring

    # Build if-else
    lines = [
        f"{indent}{kw} {destructure};",
        f"{indent}if ({cond1}) {destructure} = {true1};",
        f"{indent}else if ({cond2}) {destructure} = {true2};",
        f"{indent}else {destructure} = {false2};"
    ]
    return '\n'.join(lines), True


def process_file(path):
    with open(path, 'r', encoding='utf-8') as f:
        lines = f.readlines()

    changed_count = 0
    result = []

    for i, line in enumerate(lines):
        stripped = line.rstrip('\n')

        # Try destructuring first (more specific)
        new_line, changed = fix_destructuring_nested(stripped)
        if not changed:
            new_line, changed = fix_const_let_nested(stripped)

        if changed:
            changed_count += 1
            lineno = i + 1
            print(f"  Line {lineno}: {stripped[:80].strip()}")
            print(f"    -> transformed")
            result.append(new_line + '\n')
        else:
            result.append(line)

    with open(path, 'w', encoding='utf-8') as f:
        f.writelines(result)

    return changed_count

if __name__ == '__main__':
    path = '/home/user/SIGA/index.html'
    print("Fixing S3358 remaining const/let nested ternaries...")
    count = process_file(path)
    print(f"\nTransformed: {count} nested ternaries")
