namespace MEditService.ModFolderAdapter;

internal enum Ba2Codec
{
    None,
    Zlib,
    Lz4Block,
}

internal static class Ba2Format
{
    public const uint Lz4Compression = 3;
    public const ushort TextureChunkLength = 24;
}
