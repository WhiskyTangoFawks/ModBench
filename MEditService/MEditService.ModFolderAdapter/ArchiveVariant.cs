namespace MEditService.ModFolderAdapter;

public interface IArchiveVariant;

public enum Ba2Contents
{
    General,
    Textures,
}

public sealed record Ba2Variant(uint Version, Ba2Contents Contents, bool Compressed) : IArchiveVariant;

/// <summary>The flags come from the files an archive packs.</summary>
public sealed record BsaVariant(uint Version, bool Compressed) : IArchiveVariant;
