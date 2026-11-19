using System.Text.Json;
using System.Text.Json.Nodes;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Plugins;

namespace MEditService.Codec.Serialization;

/// <summary>The <c>spriggit-meta.json</c> beside a plugin source's header document: the file Spriggit reads
/// the package, version, release and plugin name of a source from, and fails without (ADR-0030).</summary>
public static class SpriggitMeta
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

    /// <summary>Whether <paramref name="meta"/> names <paramref name="modKey"/> as the plugin, its package and
    /// version kept; <paramref name="whyNot"/> says why not when it is no object.</summary>
    public static bool TryRenamed(byte[] meta, ModKey modKey, out byte[]? renamed, out string? whyNot)
    {
        (renamed, whyNot) = (null, null);
        if (ObjectIn(meta) is not { } held)
        {
            whyNot = "it is no JSON object.";
            return false;
        }

        held[ModKeyMember] = modKey.FileName.String;
        renamed = Written(held);
        return true;
    }

    /// <summary>Why a source whose meta is <paramref name="meta"/>, null when it holds none, is not the format
    /// <paramref name="game"/> writes; null when it is.</summary>
    public static string? WhyRefused(IGameCodec game, byte[]? meta)
    {
        var reads = $"Modbench reads {game.SpriggitPackage} {game.SpriggitVersion}";
        var decompile = $"{reads}. Decompile the plugin afresh";
        if (meta is null) return $"it is missing, so the version of the plugin source is unknown. {decompile}.";

        var held = ObjectIn(meta);
        if (held?[PackageMember] is not JsonValue package || held[VersionMember] is not JsonValue version
            || !package.TryGetValue<string>(out var packageName) || !version.TryGetValue<string>(out var versionName))
            return $"it names no package and version. {decompile}.";

        return packageName == game.SpriggitPackage && versionName == game.SpriggitVersion
            ? null
            : $"the plugin source is {packageName} {versionName}. {reads}. Move it to that version with Spriggit's upgrade command, or decompile the plugin afresh.";
    }

    private static JsonObject? ObjectIn(byte[] meta)
    {
        try
        {
            return JsonNode.Parse(meta) as JsonObject;
        }
        catch (JsonException)
        {
            return null;
        }
    }

    private static byte[] Written(JsonObject meta) => System.Text.Encoding.UTF8.GetBytes(meta.ToJsonString(Indented));
}
