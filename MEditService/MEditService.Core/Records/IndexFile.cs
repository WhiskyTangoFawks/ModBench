namespace MEditService.Core.Records;

/// <summary>
/// Where an index lives on disk (#592 / ADR-0001): <b>one DuckDB file per MO2 instance</b>, inside
/// the instance root.
///
/// <para>The instance is the only scope an index can honestly live at. Every mirror table is keyed
/// <c>(plugin, origin)</c>, and <c>origin</c> is a <i>mod folder name</i> (ADR-0036), not a path —
/// unique only within one instance. Two instances on the same game that both have a mod folder
/// called <c>Unofficial Patch</c> holding different builds of <c>UFO4P.esp</c> collide on that key,
/// so an index keyed by the game's Data install (#585's original answer) would hand one instance the
/// other's records. The trade is that the vanilla masters are indexed once per instance rather than
/// once per game: instances are rare, profiles are common, and profiles within an instance share
/// this file, which is what keeps a profile switch cheap.</para>
///
/// <para><b>Inside the instance root, never inside the content it manages.</b> The instance root is
/// MO2's own working directory — <c>ModOrganizer.ini</c>, <c>webcache/</c> — not a mod folder, so
/// putting derived state there does not violate root CLAUDE.md's never-assume-exclusive-ownership
/// rule. <c>mods/</c>, <c>overwrite/</c>, <c>profiles/</c> and <c>downloads/</c> would: a mod
/// reinstall, a profile delete or a download sweep takes anything under them with it, and a mod
/// archiver picks it up as content.</para>
/// </summary>
public static class IndexFile
{
    /// <summary>The index file for one MO2 instance. Pure — it creates nothing;
    /// <see cref="DuckDbRecordIndex"/> creates the directory when it opens.</summary>
    public static string For(string instanceRoot) =>
        // Canonicalized so that trailing separators and relative segments cannot mint a second file
        // for one instance — a profile switch that spells the root differently must find the file
        // the last one left.
        Path.Combine(
            Path.TrimEndingDirectorySeparator(Path.GetFullPath(instanceRoot)), "modbench", "index.duckdb");
}
