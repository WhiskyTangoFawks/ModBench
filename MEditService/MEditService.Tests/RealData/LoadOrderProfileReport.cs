using System.Globalization;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.RegularExpressions;
using MEditService.Tests.TestSupport;

namespace MEditService.Tests.RealData;

/// <summary>Per-plugin phase costs, summed from the load path's timing lines (#113).</summary>
public sealed class PluginCost
{
    public long ImportMs { get; set; }
    public long MetadataMs { get; set; }
    public long IndexMs { get; set; }
    public long DocumentsMs { get; set; }
    public long PrepareMs { get; set; }
    public long AppendMs { get; set; }
    public long ExtractedMs { get; set; }
    public long CommitMs { get; set; }
    public long DeserializeMs { get; set; }
    public long ReconcileMs { get; set; }
    public bool FromSource { get; set; }
    public long OpenMs => ImportMs + MetadataMs;
    public long TotalMs => OpenMs + IndexMs;
}

/// <summary>
/// One measured reconcile — cold or warm (#589) — aggregated from the Debug/Info lines the load path
/// logs. The regexes parse those lines by wording, so a rewording of one of the *required* phases'
/// lines (<c>Opened</c> in <c>LoadOrder</c>; <c>IndexInit</c>/<c>Reconciled</c> in
/// <c>LoadOrderMirror</c>; <c>Validated</c> in <c>DuckDbRecordIndex</c>) must fail <see cref="Parse"/>
/// loudly rather than silently zero that phase — see the comments above <see cref="RequiredPhases"/>
/// and above <see cref="Indexing"/> for which phases that covers and which it deliberately does not.
/// </summary>
public sealed class ProfileRun
{
    public long WallMs { get; private set; }
    public long IndexInitMs { get; private set; }
    /// <summary>#585: the open-time content-hash validation of every indexed file — the cost a warm
    /// launch pays instead of indexing.</summary>
    public long ValidateMs { get; private set; }
    public int ValidatedCount { get; private set; }
    public long ReconciledMs { get; private set; }
    public string FirstUsableMs { get; private set; } = "?";
    public long WinnersMs { get; private set; }
    public int IndexedCount { get; private set; }
    /// <summary>#586: plugins that took the registration-only path (a row, no re-index).</summary>
    public int RegisteredCount { get; private set; }
    public Dictionary<string, PluginCost> Costs { get; } = new(StringComparer.OrdinalIgnoreCase);

    public long Sum(Func<PluginCost, long> phase) => Costs.Values.Sum(phase);

    private static readonly Regex Opened = new(@"^(?<p>.+?) opened in (?<i>\d+) ms \+ (?<m>\d+) ms metadata$");

    // #616: deliberately unenforced — each of these five is legitimately absent from a *valid* run
    // shape, not a symptom of a rewording, so requiring them would make Parse throw on real,
    // correctly-measured runs:
    //  - Indexing/Indexed/IndexPhases share one population: every plugin that does NOT take the
    //    register path (RegisterOrIndex's guard, LoadOrderMirror.cs). A warm run whose whole load
    //    order is already-indexed-and-unchanged binaries — the steady state #586/ADR-0044 exists
    //    for — never logs any of the three; only Registering does. (Falsifiable directly, each
    //    verified in isolation: requiring any of the three breaks
    //    Measure_ColdThenWarm_ParsesTheRealLogLines_AndTheWarmRunRegistersEverything and
    //    Parse_DoesNotThrow_WhenNoPluginIsFreshlyIndexed_AllRegisteredWarmRun; requiring Indexed or
    //    IndexPhases additionally breaks the already-green Render_Throws_WhenTheColdRunIndexedNothing
    //    test — Indexing alone does not, because that test's filtered stream still contains an
    //    "Indexing " line.)
    //  - Registering never fires in a cold run: the index file is deleted first, so nothing is
    //    "already indexed and unchanged" yet (#585/ADR-0001).
    //  - Ingested only fires for a tracked (git-managed) plugin (ADR-0041/0042); a load order with
    //    no tracked plugins never logs it, cold or warm.
    private static readonly Regex Indexing = new(@"^Indexing (?<p>.+?) \(\d+ records\)$");
    private static readonly Regex Registering = new(@"^Registering (?<p>.+?) \(\d+ records\), already indexed and unchanged on disk$");
    private static readonly Regex Indexed = new(@"^Indexed (?<p>.+?) in (?<ms>\d+) ms$");
    private static readonly Regex IndexPhases = new(@"^Index (?<p>.+?): documents (?<d>\d+) ms \(prepare (?<pr>\d+) ms, append (?<ap>\d+) ms\), extracted tables (?<e>\d+) ms, commit (?<c>\d+) ms$");
    private static readonly Regex Ingested = new(@"^Ingested (?<p>.+?) from source: deserialize (?<d>\d+) ms, index \d+ ms, reconcile (?<r>\d+) ms$");
    private static readonly Regex IndexInit = new(@"^DuckDB record index initialized in (?<ms>\d+) ms$");
    private static readonly Regex Validated = new(@"^Validated (?<n>\d+) indexed plugin\(s\) against disk in (?<ms>\d+) ms$");
    private static readonly Regex Reconciled = new(@"^Load order reconciled in (?<t>\d+) ms: .* \(first plugin usable after (?<f>\S+) ms, winner sweep (?<w>\d+) ms\)$");

    // #616: the phases every *valid* run — cold or warm — logs unconditionally, so a miss here is
    // never a legitimate run shape; it is either a rewording or a genuinely broken measurement (e.g.
    // a load order every plugin failed to open, which is not a real profile either). Each name is a
    // field above, so a rename here fails the build rather than silently going stale.
    //
    // A rewording of one of these four is already caught by ordinary CI, not only by a real profile:
    // Measure_ColdThenWarm_ParsesTheRealLogLines_AndTheWarmRunRegistersEverything (a plain, ungated
    // [Fact] in LoadOrderProfileReportTests) runs LoadOrderProfile.Measure over a real fixture
    // instance and parses the load path's actual emitted lines, so a required-phase reword fails
    // there — verified directly by breaking the IndexInit pattern and watching that test fail with
    // "No log line matched for required phase(s) IndexInit". Separately, this same check also fires
    // at real measurement time (LoadOrderProfile.ProfileReconcile, env-gated), turning a drifted log
    // text into a loud exception instead of a quietly-zeroed phase in the report. What remains
    // genuinely unprotected, in both places, is the five optional phases above: a rewording there
    // still zeros that phase silently, because nothing checks that they matched at all.
    private static readonly string[] RequiredPhases = [nameof(Opened), nameof(IndexInit), nameof(Validated), nameof(Reconciled)];

    public static ProfileRun Parse(IEnumerable<LogEntry> entries, long wallMs)
    {
        var run = new ProfileRun { WallMs = wallMs };
        PluginCost Cost(string p) => run.Costs.TryGetValue(p, out var c) ? c : run.Costs[p] = new PluginCost();
        var matched = new HashSet<string>(StringComparer.Ordinal);

        foreach (var e in entries)
        {
            Match m;
            if ((m = Opened.Match(e.Message)).Success) { var c = Cost(m.Groups["p"].Value); c.ImportMs = Ms(m, "i"); c.MetadataMs = Ms(m, "m"); matched.Add(nameof(Opened)); }
            else if ((m = Indexing.Match(e.Message)).Success) { Cost(m.Groups["p"].Value); run.IndexedCount++; }
            else if ((m = Registering.Match(e.Message)).Success) { Cost(m.Groups["p"].Value); run.RegisteredCount++; }
            else if ((m = Indexed.Match(e.Message)).Success) Cost(m.Groups["p"].Value).IndexMs = Ms(m, "ms");
            else if ((m = IndexPhases.Match(e.Message)).Success) { var c = Cost(m.Groups["p"].Value); c.DocumentsMs = Ms(m, "d"); c.PrepareMs = Ms(m, "pr"); c.AppendMs = Ms(m, "ap"); c.ExtractedMs = Ms(m, "e"); c.CommitMs = Ms(m, "c"); }
            else if ((m = Ingested.Match(e.Message)).Success) { var c = Cost(m.Groups["p"].Value); c.FromSource = true; c.DeserializeMs = Ms(m, "d"); c.ReconcileMs = Ms(m, "r"); }
            else if ((m = IndexInit.Match(e.Message)).Success) { run.IndexInitMs = Ms(m, "ms"); matched.Add(nameof(IndexInit)); }
            else if ((m = Validated.Match(e.Message)).Success) { run.ValidatedCount = (int)Ms(m, "n"); run.ValidateMs = Ms(m, "ms"); matched.Add(nameof(Validated)); }
            else if ((m = Reconciled.Match(e.Message)).Success) { run.ReconciledMs = Ms(m, "t"); run.WinnersMs = Ms(m, "w"); run.FirstUsableMs = m.Groups["f"].Value; matched.Add(nameof(Reconciled)); }
        }

        var missing = RequiredPhases.Where(p => !matched.Contains(p)).ToList();
        if (missing.Count > 0)
        {
            throw new InvalidOperationException(
                $"No log line matched for required phase(s) {string.Join(", ", missing)} — the log texts in " +
                "LoadOrder/LoadOrderMirror/SourceIngest/DuckDbRecordIndex changed; update the regexes.");
        }
        return run;
    }

    private static long Ms(Match m, string group) => long.Parse(m.Groups[group].Value, CultureInfo.InvariantCulture);
}

public sealed record ProfileHeader(string InstanceRoot, string Profile, string DataFolder, int ExplicitCount, int OpenedCount, int FailureCount);

/// <summary>The markdown report: cold and warm side by side (#589), then the cold run's per-plugin
/// breakdown — a warm run has no per-plugin index cost to rank.</summary>
public static class LoadOrderProfileReport
{
    public static string Render(
        ProfileHeader header, ProfileRun cold, ProfileRun warm,
        IReadOnlyDictionary<string, int> records, IReadOnlyList<(string Name, string Reason)> failures)
    {
        if (cold.IndexedCount == 0 || cold.Sum(c => c.IndexMs) == 0)
            throw new InvalidOperationException("The cold run indexed nothing — the index file was not cleared before it, or the 'Indexing'/'Indexed' log texts changed; update the harness.");

        var totalRecords = records.Values.Sum();
        var sb = new StringBuilder();
        sb.AppendLine("# Load-order profile: cold vs warm launch (#113, #589)");
        sb.AppendLine();
        sb.AppendLine(CultureInfo.InvariantCulture, $"- Instance: `{header.InstanceRoot}` profile `{header.Profile}`; Data: `{header.DataFolder}`");
        sb.AppendLine(CultureInfo.InvariantCulture, $"- Plugins: {header.ExplicitCount} explicit + forced masters/CC = {header.OpenedCount} opened, {totalRecords:N0} records, {header.FailureCount} load failures");
        sb.AppendLine(CultureInfo.InvariantCulture, $"- Machine: {RuntimeInformation.OSDescription}, {Environment.ProcessorCount} logical cores, {RuntimeInformation.FrameworkDescription}");
        sb.AppendLine(CultureInfo.InvariantCulture, $"- Date: {DateTime.Now:yyyy-MM-dd}");
        sb.AppendLine("- Cold: the instance's index file deleted first, so every plugin is indexed. Warm: the mirror disposed and the identical order reconciled again over the file the cold run left.");
        sb.AppendLine();
        sb.AppendLine("## Totals");
        sb.AppendLine();
        sb.AppendLine("| Phase | cold ms | warm ms | cold share | warm share |");
        sb.AppendLine("|---|---:|---:|---:|---:|");
        void Row(string name, Func<ProfileRun, long> phase)
        {
            long c = phase(cold), w = phase(warm);
            sb.AppendLine(CultureInfo.InvariantCulture, $"| {name} | {c:N0} | {w:N0} | {Share(c, cold.WallMs)} | {Share(w, warm.WallMs)} |");
        }
        Row("Wall clock (Reconcile round trip)", r => r.WallMs);
        Row("DuckDB index open (DDL + views)", r => r.IndexInitMs);
        Row("Validate indexed files against disk (hash)", r => r.ValidateMs);
        Row("Binary open — ModFactory.ImportGetter", r => r.Sum(c => c.ImportMs));
        Row("Binary open — BuildPluginMetadata (record count)", r => r.Sum(c => c.MetadataMs));
        Row("Index (all plugins)", r => r.Sum(c => c.IndexMs));
        Row("  ├ documents (enumerate + serialize + hash + refs + append)", r => r.Sum(c => c.DocumentsMs));
        Row("  │  ├ parallel prepare (serialize, hash, refs, children)", r => r.Sum(c => c.PrepareMs));
        Row("  │  └ sequential append", r => r.Sum(c => c.AppendMs));
        Row("  ├ extracted tables (placement, header, lookup/refs/child flush)", r => r.Sum(c => c.ExtractedMs));
        Row("  └ commit", r => r.Sum(c => c.CommitMs));
        Row("  tracked-only: source deserialize", r => r.Sum(c => c.DeserializeMs));
        Row("  tracked-only: reconcile head", r => r.Sum(c => c.ReconcileMs));
        Row("Winner sweep (UpdateWinners)", r => r.WinnersMs);
        Row("Unattributed (wall − repo open − validate − binary open − index − winners)", Unattributed);
        sb.AppendLine();
        sb.AppendLine(Summary("Cold", cold));
        sb.AppendLine(Summary("Warm", warm));
        sb.AppendLine();
        sb.AppendLine("## Top 20 plugins by cost (cold)");
        sb.AppendLine();
        sb.AppendLine("| Plugin | records | open ms | index ms | documents | prepare | append | extracted | commit | src | total ms | µs/record |");
        sb.AppendLine("|---|---:|---:|---:|---:|---:|---:|---:|---:|:-:|---:|---:|");
        foreach (var (name, c) in cold.Costs.OrderByDescending(kv => kv.Value.TotalMs).Take(20))
        {
            var n = records.GetValueOrDefault(name);
            sb.AppendLine(CultureInfo.InvariantCulture, $"| {name} | {n:N0} | {c.OpenMs:N0} | {c.IndexMs:N0} | {c.DocumentsMs:N0} | {c.PrepareMs:N0} | {c.AppendMs:N0} | {c.ExtractedMs:N0} | {c.CommitMs:N0} | {(c.FromSource ? "src" : "bin")} | {c.TotalMs:N0} | {(n > 0 ? 1000.0 * c.TotalMs / n : 0):F0} |");
        }
        sb.AppendLine();
        sb.AppendLine("## Cost-per-record outliers (cold; ≥ 200 records, top 10 by µs/record)");
        sb.AppendLine();
        sb.AppendLine("| Plugin | records | total ms | µs/record |");
        sb.AppendLine("|---|---:|---:|---:|");
        foreach (var (name, c) in cold.Costs.Where(kv => records.GetValueOrDefault(kv.Key) >= 200)
                     .OrderByDescending(kv => (double)kv.Value.TotalMs / records[kv.Key]).Take(10))
        {
            var n = records[name];
            sb.AppendLine(CultureInfo.InvariantCulture, $"| {name} | {n:N0} | {c.TotalMs:N0} | {1000.0 * c.TotalMs / n:F0} |");
        }
        if (failures.Count > 0)
        {
            sb.AppendLine();
            sb.AppendLine("## Load failures");
            sb.AppendLine();
            foreach (var f in failures) sb.AppendLine(CultureInfo.InvariantCulture, $"- {f.Name}: {f.Reason}");
        }
        return sb.ToString();
    }

    private static long Unattributed(ProfileRun r) =>
        r.WallMs - r.IndexInitMs - r.ValidateMs - r.Sum(c => c.ImportMs) - r.Sum(c => c.MetadataMs) - r.Sum(c => c.IndexMs) - r.WinnersMs;

    private static string Share(long ms, long wallMs) =>
        (wallMs > 0 ? 100.0 * ms / wallMs : 0).ToString("F1", CultureInfo.InvariantCulture) + "%";

    private static string Summary(string label, ProfileRun r) =>
        string.Create(CultureInfo.InvariantCulture,
            $"{label}: reconciled in {r.ReconciledMs:N0} ms, first plugin usable after {r.FirstUsableMs} ms, {r.IndexedCount} indexed, {r.RegisteredCount} registered, {r.ValidatedCount} validated against disk in {r.ValidateMs:N0} ms.");
}
