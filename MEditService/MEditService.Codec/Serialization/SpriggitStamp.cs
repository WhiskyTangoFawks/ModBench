using System.Text.Json;
using System.Text.Json.Nodes;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Plugins;

namespace MEditService.Codec.Serialization;

/// <summary>The <c>spriggit-meta.json</c> beside a plugin source's header document: the file Spriggit reads
/// the package, version, release and plugin name of a source from, and fails without (ADR-0030).</summary>
public static class SpriggitStamp
{
    public const string FileName = "spriggit-meta.json";

    private const string PackageMember = "PackageName";
    private const string VersionMember = "Version";
    private const string ModKeyMember = "ModKey";

    private static readonly JsonSerializerOptions Indented = new() { WriteIndented = true, NewLine = "\n" };

    public static TreeFile Of(IGameCodec game, ModKey modKey, GameRelease release) =>
        new(FileName, Written(new JsonObject
        {
            [PackageMember] = game.SpriggitPackage,
            [VersionMember] = game.SpriggitVersion,
            ["Release"] = release.ToString(),
            [ModKeyMember] = modKey.FileName.String,
        }));

    /// <summary><paramref name="stamp"/> naming <paramref name="modKey"/> as the plugin, its package and version kept.</summary>
    public static byte[] Renamed(byte[] stamp, ModKey modKey)
    {
        var held = (JsonObject)(JsonNode.Parse(stamp) ?? throw new JsonException("The stamp is no object."));
        held[ModKeyMember] = modKey.FileName.String;
        return Written(held);
    }

    /// <summary>Why a source holding <paramref name="stamp"/>, null when it holds none, is not the format
    /// <paramref name="game"/> writes; null when it is.</summary>
    public static string? WhyRefused(IGameCodec game, byte[]? stamp)
    {
        var reads = $"Modbench reads {game.SpriggitPackage} {game.SpriggitVersion}";
        const string ways = "Move it to that version with Spriggit's upgrade command, or decompile the plugin afresh";
        if (stamp is null) return $"it is missing, so the version of the plugin source is unknown. {reads}. {ways}.";

        var (package, version) = Held(stamp);
        if (package is null || version is null) return $"it names no package and version. {reads}. {ways}.";
        return package == game.SpriggitPackage && version == game.SpriggitVersion
            ? null
            : $"the plugin source is {package} {version}. {reads}. {ways}.";
    }

    private static (string? Package, string? Version) Held(byte[] stamp)
    {
        try
        {
            return JsonNode.Parse(stamp) is JsonObject held
                ? (held[PackageMember]?.GetValue<string>(), held[VersionMember]?.GetValue<string>())
                : (null, null);
        }
        catch (Exception ex) when (ex is JsonException or InvalidOperationException)
        {
            return (null, null);
        }
    }

    private static byte[] Written(JsonObject stamp) => System.Text.Encoding.UTF8.GetBytes(stamp.ToJsonString(Indented));
}
