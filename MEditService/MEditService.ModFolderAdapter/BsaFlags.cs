namespace MEditService.ModFolderAdapter;

/// <summary>The flags BSArch's <c>DetectFlags</c> derives for a Skyrim LE or Skyrim SE archive from the files it packs,
/// except the embedded-names flag of an archive of textures, which <see cref="BsaWriter"/> does not write.</summary>
internal static class BsaFlags
{
    private const uint FolderAndFileNames = 0x3;
    private const uint Compressed = 0x4;
    private const uint RetainNames = 0x10;
    private const uint StartupStrings = 0x80;

    private const uint Meshes = 0x1;
    private const uint Textures = 0x2;
    private const uint Sounds = 0x8;
    private const uint Voices = 0x10;
    private const uint Trees = 0x40;
    private const uint Misc = 0x100;

    private const uint SkyrimSe = 105;

    private enum Asset
    {
        None, Mesh, Texture, Voice, Sound, Script, SpeedTree, LodSettings, DistantLod, Menus, Font, Other,
    }

    private sealed record Kind(Asset Asset, string Root, string[] Extensions);

    // In BSArch's order: the first kind whose folder holds the file wins, then the first whose extension is the file's.
    private static readonly Kind[] Kinds =
    [
        new(Asset.Mesh, "meshes", [".nif", ".kf", ".kfm", ".egm", ".egt", ".tri", ".psa", ".hkt", ".hkx", ".ssf", ".btr", ".bto", ".btt", ".dtl"]),
        new(Asset.Texture, "textures", [".dds", ".tga", ".png"]),
        new(Asset.Other, "materials", [".bgsm", ".bgem"]),
        new(Asset.Other, "geometries", [".mesh"]),
        new(Asset.Voice, "sound\\voice", [".lip", ".wav", ".xwm", ".mp3", ".ogg", ".fuz"]),
        new(Asset.Sound, "sound", [".wav", ".xwm", ".ogg"]),
        new(Asset.Other, "music", [".xwm", ".mp3"]),
        new(Asset.Other, "scripts\\source", [".psc"]),
        new(Asset.Other, "source\\scripts", [".psc"]),
        new(Asset.Script, "scripts", [".pex", ".psc"]),
        new(Asset.Other, "strings", [".strings", ".ilstrings", ".dlstrings"]),
        new(Asset.SpeedTree, "trees", [".spt"]),
        new(Asset.Other, "video", [".bik", ".bk2"]),
        new(Asset.LodSettings, "lodsettings", [".lodsettings", ".dlodsettings", ".lod"]),
        new(Asset.DistantLod, "distantlod", [".cmp", ".lod"]),
        new(Asset.Other, "interface", [".swf", ".png", ".txt"]),
        new(Asset.Other, "programs", [".swf"]),
        new(Asset.Menus, "menus", [".xml", ".htm", ".txt", ".scc", ".bat"]),
        new(Asset.Font, "fonts", [".fnt", ".tex"]),
        new(Asset.Other, "facegen", [".ctl"]),
        new(Asset.Other, "lsdata", [".dat"]),
        new(Asset.Other, "shaders", [".sdp"]),
        new(Asset.Other, "shadersfx", [".fxp"]),
        new(Asset.Other, "grass", [".gid"]),
        new(Asset.Other, "vis", [".uvd"]),
        new(Asset.Other, "seq", [".seq"]),
        new(Asset.Other, "dialogueviews", [".xml"]),
        new(Asset.Other, "bookart", [".dds", ".tga"]),
        new(Asset.Other, "icons", [".dds", ".tga"]),
        new(Asset.Other, "splash", [".dds", ".tga"]),
    ];

    public static (uint ArchiveFlags, uint FileFlags) Derive(uint version, bool compressed, IReadOnlyList<PackedFile> files)
    {
        var archive = FolderAndFileNames;
        uint file = 0;
        foreach (var packed in files)
        {
            var asset = AssetOf(packed);
            file |= FileFlagOf(asset);
            if (asset == Asset.Script) archive |= RetainNames;
        }

        if (version == SkyrimSe) file &= ~Misc;
        if ((file & Meshes) != 0) archive |= StartupStrings;
        if ((file & Sounds) != 0) archive |= RetainNames;
        if (compressed) archive |= Compressed;
        return (archive, file);
    }

    private static Asset AssetOf(PackedFile file)
    {
        var byFolder = Kinds.FirstOrDefault(kind => file.Name.StartsWith(kind.Root + '\\', StringComparison.Ordinal));
        if (byFolder is not null) return byFolder.Asset;
        return Kinds.FirstOrDefault(kind => kind.Extensions.Contains(file.Extension, StringComparer.Ordinal))?.Asset ?? Asset.None;
    }

    // Menus and fonts are Oblivion's flags, so a Skyrim archive sets none for them.
    private static uint FileFlagOf(Asset asset) => asset switch
    {
        Asset.Mesh => Meshes,
        Asset.Texture => Textures,
        Asset.Sound => Sounds,
        Asset.Voice => Voices,
        Asset.SpeedTree => Trees,
        Asset.DistantLod or Asset.LodSettings => Meshes | Misc,
        Asset.Menus or Asset.Font => 0,
        _ => Misc,
    };
}
