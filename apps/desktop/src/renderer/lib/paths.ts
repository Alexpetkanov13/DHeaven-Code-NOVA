export const parentOf = (rel: string) => (rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/')) : '');
export const joinRel = (dir: string, name: string) => (dir ? `${dir}/${name}` : name).replace(/\\/g, '/');
