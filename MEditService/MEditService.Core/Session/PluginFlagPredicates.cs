using Mutagen.Bethesda.Plugins.Records;

namespace MEditService.Core.Session;

/// <summary>
/// Engine-authoritative light/master predicate (#509), shared by every call site that needs to
/// know whether a plugin is light or a master — <see cref="GameSession"/>'s
/// <c>BuildPluginMetadata</c> today, <c>RecordEditService</c>'s ESL FormID cap (#501) next. The
/// overwhelmingly common light plugin in the wild is a header-flagged <c>.esp</c>, not a distinct
/// extension, and an ESM-flagged <c>.esp</c> is a legal, common master; a filename-only check
/// misses both. Matches Mutagen's own <c>IModFlagsGetter</c> semantics
/// (<c>references/Mutagen/Mutagen.Bethesda.Core/Plugins/Records/ModFlags.cs</c>) — the header flag
/// is authoritative, the extension is a secondary path for a flag-less plugin still named
/// <c>.esl</c>/<c>.esm</c>.
///
/// <para>Plain static methods, not extension methods: an extension method named <c>IsMaster</c> on
/// <see cref="IModFlagsGetter"/> would collide with that interface's own <c>IsMaster</c> property at
/// every call site — member lookup finds the property first and the extension is never
/// considered.</para>
/// </summary>
public static class PluginFlagPredicates
{
    public static bool IsLight(IModFlagsGetter mod, string fileName) =>
        mod.IsSmallMaster || fileName.EndsWith(".esl", StringComparison.OrdinalIgnoreCase);

    public static bool IsMaster(IModFlagsGetter mod, string fileName) =>
        mod.IsMaster || fileName.EndsWith(".esm", StringComparison.OrdinalIgnoreCase);
}
