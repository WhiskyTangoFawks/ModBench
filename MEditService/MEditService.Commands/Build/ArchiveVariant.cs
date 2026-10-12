namespace MEditService.Commands.Build;

/// <summary>The kind of archive to pack and the header fields of the game release it is for. The packer holds no
/// game: the release's table says which variant its archives are.</summary>
public interface IArchiveVariant;

public enum Ba2Contents
{
    General,
    Textures,
}

public sealed record Ba2Variant(uint Version, Ba2Contents Contents, bool Compressed) : IArchiveVariant;

/// <summary>The archive flags carry whether the files are compressed.</summary>
public sealed record BsaVariant(uint Version, uint ArchiveFlags, uint FileFlags) : IArchiveVariant;
