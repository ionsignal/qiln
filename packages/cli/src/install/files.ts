import { constants, type Stats } from 'node:fs'
import { chmod, mkdtemp, open, readdir, rm, type FileHandle } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'

const FILE_FLAGS = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK
const DIRECTORY_FLAGS = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW | constants.O_NONBLOCK
const INSPECT_FLAGS = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK
const TEMP_FLAGS = constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW

export type FileKind = 'file' | 'directory'
export type FileValidationKind = 'type' | 'owner' | 'mode' | 'size' | 'changed'

export interface FileSnapshot {
  readonly bytes: Uint8Array
  readonly size: number
}

export interface EntryOptions {
  owner?: number
  mode?: number
}

export interface ReadOptions extends EntryOptions {
  minSize?: number
  maxSize: number
}

export interface InspectOptions {
  owner?: number
  fileMode?: number
  directoryMode?: number
}

export class FileValidationError extends Error {
  constructor(
    public readonly kind: FileValidationKind,
    public readonly path: string,
    public readonly entryType?: FileKind,
  ) {
    super(`Installer file validation failed for '${path}'.`)
    this.name = 'FileValidationError'
  }
}

/**
 * Opened directory capability used to access children through the original
 * descriptor rather than through a path that can later be replaced.
 */
export class Dir {
  private readonly root: string
  private closed = false

  constructor(
    public readonly path: string,
    private readonly handle: FileHandle,
  ) {
    this.root = `/proc/self/fd/${handle.fd}`
  }

  public child(name: string): string {
    this.assertOpen()
    assertChildName(name)
    return `${this.root}/${name}`
  }

  public async list(): Promise<string[]> {
    this.assertOpen()
    return (await readdir(this.root)).sort()
  }

  public async close(): Promise<void> {
    if (this.closed) {
      return
    }
    this.closed = true
    await this.handle.close()
  }

  private assertOpen(): void {
    if (this.closed) {
      throw new Error(`Installer directory '${this.path}' is closed.`)
    }
  }
}

function isErrorCode(value: unknown, code: string): boolean {
  return typeof value === 'object' && value !== null && 'code' in value && value.code === code
}

function assertChildName(value: string): void {
  if (value === '' || value === '.' || value === '..' || value.includes('/') || value.includes('\0')) {
    throw new RangeError('Installer directory children must use one normal filename.')
  }
}

function modeOf(metadata: Stats): number {
  return metadata.mode & 0o7777
}

function assertSizeOptions(options: ReadOptions): void {
  const minimum = options.minSize ?? 0
  if (
    !Number.isSafeInteger(minimum) ||
    minimum < 0 ||
    !Number.isSafeInteger(options.maxSize) ||
    options.maxSize < minimum
  ) {
    throw new RangeError('Installer file size limits must be safe non-negative integers.')
  }
}

function validate(metadata: Stats, expectedType: FileKind, path: string, options: EntryOptions): void {
  const typeMatches = expectedType === 'file' ? metadata.isFile() : metadata.isDirectory()
  if (!typeMatches) {
    throw new FileValidationError('type', path, expectedType)
  }
  if (options.owner !== undefined && metadata.uid !== options.owner) {
    throw new FileValidationError('owner', path, expectedType)
  }
  if (options.mode !== undefined && modeOf(metadata) !== options.mode) {
    throw new FileValidationError('mode', path, expectedType)
  }
}

function validateSize(metadata: Stats, path: string, options: ReadOptions): void {
  const minimum = options.minSize ?? 0
  if (!Number.isSafeInteger(metadata.size) || metadata.size < minimum || metadata.size > options.maxSize) {
    throw new FileValidationError('size', path, 'file')
  }
}

function isUnchanged(left: Stats, right: Stats): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mode === right.mode &&
    left.uid === right.uid &&
    left.gid === right.gid &&
    left.mtimeMs === right.mtimeMs &&
    left.ctimeMs === right.ctimeMs
  )
}

async function openNoFollow(path: string, flags: number, expectedType?: FileKind): Promise<FileHandle> {
  try {
    return await open(path, flags)
  } catch (error: unknown) {
    if (isErrorCode(error, 'ELOOP') || (expectedType === 'directory' && isErrorCode(error, 'ENOTDIR'))) {
      throw new FileValidationError('type', path, expectedType)
    }
    throw error
  }
}

async function snapshot(handle: FileHandle, path: string, options: ReadOptions): Promise<FileSnapshot> {
  assertSizeOptions(options)

  const before = await handle.stat()

  validate(before, 'file', path, options)
  validateSize(before, path, options)

  const bytes = new Uint8Array(before.size)
  let offset = 0
  while (offset < bytes.length) {
    const result = await handle.read(bytes, offset, bytes.length - offset, offset)
    if (result.bytesRead === 0) {
      break
    }
    offset += result.bytesRead
  }
  if (offset !== bytes.length) {
    throw new FileValidationError('changed', path, 'file')
  }
  const after = await handle.stat()

  validate(after, 'file', path, options)
  validateSize(after, path, options)

  if (!isUnchanged(before, after)) {
    throw new FileValidationError('changed', path, 'file')
  }
  return Object.freeze({
    bytes,
    size: bytes.byteLength,
  })
}

async function readAt(path: string, options: ReadOptions): Promise<FileSnapshot> {
  const handle = await openNoFollow(path, FILE_FLAGS, 'file')
  try {
    return await snapshot(handle, path, options)
  } finally {
    await handle.close()
  }
}

/**
 * Reads one regular file through an opened parent directory so a later path
 * replacement cannot redirect the file access.
 */
export async function read(path: string, options: ReadOptions): Promise<FileSnapshot> {
  const directory = await openDir(dirname(path))
  try {
    return await readChild(directory, basename(path), options)
  } finally {
    await directory.close()
  }
}

/**
 * Opens one directory without following its final path component.
 */
export async function openDir(path: string, options: EntryOptions = {}): Promise<Dir> {
  const handle = await openNoFollow(path, DIRECTORY_FLAGS, 'directory')
  try {
    validate(await handle.stat(), 'directory', path, options)
    return new Dir(path, handle)
  } catch (error: unknown) {
    await handle.close()
    throw error
  }
}

/**
 * Reads one regular child through a stable opened directory descriptor.
 */
export async function readChild(directory: Dir, name: string, options: ReadOptions): Promise<FileSnapshot> {
  return await readAt(directory.child(name), options)
}

/**
 * Validates one direct state-directory entry without following a symlink.
 *
 * The caller must not use this inspection result to reopen the same path for
 * data. Known files should instead be read once through `readChild()`.
 */
export async function inspectChild(directory: Dir, name: string, options: InspectOptions = {}): Promise<FileKind> {
  const path = directory.child(name)
  const handle = await openNoFollow(path, INSPECT_FLAGS)
  try {
    const metadata = await handle.stat()
    if (metadata.isFile()) {
      validate(metadata, 'file', path, {
        owner: options.owner,
        mode: options.fileMode,
      })
      return 'file'
    }
    if (metadata.isDirectory()) {
      validate(metadata, 'directory', path, {
        owner: options.owner,
        mode: options.directoryMode,
      })
      return 'directory'
    }
    throw new FileValidationError('type', path)
  } finally {
    await handle.close()
  }
}

/**
 * Materializes exact snapshot bytes into a private temporary file and removes
 * the containing directory after the callback completes or fails.
 */
export async function withTemp<T>(snapshot: FileSnapshot, run: (path: string) => Promise<T>): Promise<T> {
  if (snapshot.size !== snapshot.bytes.byteLength || !Number.isSafeInteger(snapshot.size) || snapshot.size < 0) {
    throw new RangeError('Installer file snapshots must contain a valid byte length.')
  }
  const directory = await mkdtemp(join(tmpdir(), 'qiln-'))
  const path = join(directory, 'snapshot')
  try {
    await chmod(directory, 0o700)
    const handle = await open(path, TEMP_FLAGS, 0o600)
    try {
      await handle.writeFile(snapshot.bytes)
      await handle.sync()
      await handle.chmod(0o600)
      const metadata = await handle.stat()

      validate(metadata, 'file', path, {
        mode: 0o600,
      })

      if (metadata.size !== snapshot.size) {
        throw new FileValidationError('changed', path, 'file')
      }
    } finally {
      await handle.close()
    }
    return await run(path)
  } finally {
    await rm(directory, {
      recursive: true,
      force: true,
    })
  }
}
