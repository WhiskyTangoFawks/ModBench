namespace MEditService.Commands.Build;

public interface IArchiveVariant;

public enum Ba2Contents
{
    General,
    Textures,
}

public sealed record Ba2Variant(uint Version, Ba2Contents Contents, bool Compressed) : IArchiveVariant;

/// <summary>The archive flags carry whether the files are compressed.</summary>
public sealed record BsaVariant(uint Version, uint ArchiveFlags, uint FileFlags) : IArchiveVariant;
