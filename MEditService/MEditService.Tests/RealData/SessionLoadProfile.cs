using System.Diagnostics;
using System.Globalization;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.RegularExpressions;
using MEditService.Core.Records;
using MEditService.Core.Session;
using MEditService.Tests.TestSupport;
using Microsoft.Extensions.Logging;
using Mutagen.Bethesda;
using Xunit.Abstractions;

namespace MEditService.Tests.RealData;

/// <summary>
/// #113: the session-load profiling harness. Loads a real MO2 instance's active profile exactly the
/// way the extension does (<c>modbench/src/modmanager/explicitSession.ts</c>: plugins.txt order,
/// every line enabled or not, each name resolved overwrite → first enabled mod in modlist.txt order
/// → game Data folder) through <see cref="SessionManager.LoadExplicit"/>, and aggregates the
/// per-phase timing lines the load path logs (#113) into a report — total, phase split, top plugins
/// by cost, cost-per-record outliers.
///
/// Environment-dependent and slow, so gated: set <c>MEDIT_PROFILE_INSTANCE</c> to the MO2 instance
/// root (the folder holding <c>ModOrganizer.ini</c>, <c>mods/</c>, <c>profiles/</c>). The game Data
/// folder is read from the ini's <c>gamePath</c> (a Wine path like <c>Z:\home\...</c> is unwrapped),
/// or set <c>MEDIT_PROFILE_DATA</c> explicitly. <c>MEDIT_PROFILE_OUT</c> names the report file
/// (default: <c>session-load-profile.md</c> in the working directory). One measurement, not a
/// benchmark suite — run it alone, on a quiet machine.
/// </summary>
public sealed class SessionLoadProfile(ITestOutputHelper output)
{
    private sealed class ProfileFactAttribute : FactAttribute
    {
        public ProfileFactAttribute()
        {
            if (string.IsNullOrEmpty(Environment.GetEnvironmentVariable("MEDIT_PROFILE_INSTANCE")))
                Skip = "Set MEDIT_PROFILE_INSTANCE=<MO2 instance root> to run the session-load profile.";
        }
    }

    private sealed record ModEntry(string Name, bool Enabled);

    [ProfileFact]
    public void ProfileSessionLoad()
    {
        var instanceRoot = Environment.GetEnvironmentVariable("MEDIT_PROFILE_INSTANCE")!;
        var ini = File.ReadAllLines(Path.Combine(instanceRoot, "ModOrganizer.ini"));
        var dataFolder = Environment.GetEnvironmentVariable("MEDIT_PROFILE_DATA")
            ?? Path.Combine(UnwrapWinePath(IniValue(ini, "gamePath")), "Data");
        var profile = IniValue(ini, "selected_profile");
        var profileDir = Path.Combine(instanceRoot, "profiles", profile);

        var plugins = ResolveExplicitPlugins(instanceRoot, profileDir, dataFolder);

        var entries = new List<LogEntry>();
        using var loggerFactory = LoggerFactory.Create(b => b.SetMinimumLevel(LogLevel.Debug).AddProvider(new CollectingLoggerProvider(entries)));
        using var sessions = new SessionManager(
            new DuckDbRecordIndexFactory(
                SharedSchemaReflector.Instance, new TableDdlBuilder(SharedSchemaReflector.Instance),
                loggerFactory.CreateLogger<DuckDbRecordIndexFactory>()),
            loggerFactory.CreateLogger<SessionManager>());

        var wall = Stopwatch.StartNew();
        ((ISessionManager)sessions).LoadExplicit(dataFolder, plugins, GameRelease.Fallout4);
        wall.Stop();

        var session = sessions.Session!;
        var report = BuildReport(instanceRoot, profile, dataFolder, plugins.Count, session, entries, wall.ElapsedMilliseconds);

        var outPath = Environment.GetEnvironmentVariable("MEDIT_PROFILE_OUT") ?? "session-load-profile.md";
        File.WriteAllText(outPath, report);
        output.WriteLine(report);
        output.WriteLine($"Report written to {Path.GetFullPath(outPath)}");
    }

    // --- MO2 resolution, mirroring explicitSession.ts ---

    private static List<ExplicitPluginInput> ResolveExplicitPlugins(string instanceRoot, string profileDir, string dataFolder)
    {
        // modlist.txt: top line = highest priority; '+' enabled, '-' disabled, '*' separator.
        var modlist = File.ReadAllLines(Path.Combine(profileDir, "modlist.txt"))
            .Where(l => l.Length > 1 && (l[0] == '+' || l[0] == '-'))
            .Select(l => new ModEntry(l[1..], l[0] == '+'))
            .ToList();

        // Root-level files of each enabled mod, first (highest-priority) provider wins.
        var winnerByName = new Dictionary<string, (string Origin, string Path)>(StringComparer.OrdinalIgnoreCase);
        foreach (var mod in modlist.Where(m => m.Enabled))
        {
            var modDir = Path.Combine(instanceRoot, "mods", mod.Name);
            if (!Directory.Exists(modDir)) continue;
            foreach (var file in Directory.EnumerateFiles(modDir))
                winnerByName.TryAdd(Path.GetFileName(file), (mod.Name, file));
        }

        var overwriteDir = Path.Combine(instanceRoot, "overwrite");
        var overwriteFiles = Directory.Exists(overwriteDir)
            ? Directory.EnumerateFiles(overwriteDir).ToDictionary(f => Path.GetFileName(f)!, f => f, StringComparer.OrdinalIgnoreCase)
            : new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);

        var result = new List<ExplicitPluginInput>();
        foreach (var raw in File.ReadAllLines(Path.Combine(profileDir, "plugins.txt")))
        {
            var line = raw.Trim();
            if (line.Length == 0 || line[0] == '#') continue;
            var participates = line[0] == '*';
            var name = participates ? line[1..] : line;

            if (overwriteFiles.TryGetValue(name, out var overwritePath))
                result.Add(new ExplicitPluginInput(name, overwritePath, "overwrite", participates));
            else if (winnerByName.TryGetValue(name, out var winner))
                result.Add(new ExplicitPluginInput(name, winner.Path, winner.Origin, participates));
            else
                result.Add(new ExplicitPluginInput(name, Path.Combine(dataFolder, name), PluginOrigin.DataDirectory, participates));
        }
        return result;
    }

    private static string IniValue(string[] ini, string key)
    {
        var line = ini.First(l => l.StartsWith(key + " =", StringComparison.Ordinal) || l.StartsWith(key + "=", StringComparison.Ordinal));
        var value = line[(line.IndexOf('=') + 1)..].Trim();
        // @ByteArray(...) wrapper, doubled backslashes.
        if (value.StartsWith("@ByteArray(", StringComparison.Ordinal)) value = value["@ByteArray(".Length..^1];
        return value.Replace(@"\\", @"\");
    }

    private static string UnwrapWinePath(string path)
    {
        if (path.Length > 2 && path[1] == ':') path = path[2..]; // Z:\home\... → \home\...
        return path.Replace('\\', '/');
    }

    // --- Report ---

    private sealed class PluginCost
    {
        public long ImportMs, MetadataMs, IndexMs, DocumentsMs, PrepareMs, AppendMs, ExtractedMs, CommitMs, DeserializeMs, ReconcileMs;
        public bool FromSource;
        public long OpenMs => ImportMs + MetadataMs;
        public long TotalMs => OpenMs + IndexMs;
    }

    private static readonly Regex Opened = new(@"^\[\d+\] (?<p>.+?) opened in (?<i>\d+) ms \+ (?<m>\d+) ms metadata$");
    private static readonly Regex Indexed = new(@"^Indexed (?<p>.+?) in (?<ms>\d+) ms$");
    private static readonly Regex IndexPhases = new(@"^Index (?<p>.+?): documents (?<d>\d+) ms \(prepare (?<pr>\d+) ms, append (?<ap>\d+) ms\), extracted tables (?<e>\d+) ms, commit (?<c>\d+) ms$");
    private static readonly Regex Ingested = new(@"^Ingested (?<p>.+?) from source: deserialize (?<d>\d+) ms, index \d+ ms, reconcile (?<r>\d+) ms$");
    private static readonly Regex RepoInit = new(@"^DuckDB record repository initialized in (?<ms>\d+) ms$");
    private static readonly Regex Loaded = new(@"^Session fully loaded in (?<t>\d+) ms \(first plugin usable after (?<f>\S+) ms, winner sweep (?<w>\d+) ms\)$");

    private static string BuildReport(
        string instanceRoot, string profile, string dataFolder, int explicitCount,
        IGameSession session, List<LogEntry> entries, long wallMs)
    {
        var costs = new Dictionary<string, PluginCost>(StringComparer.OrdinalIgnoreCase);
        PluginCost Cost(string p) => costs.TryGetValue(p, out var c) ? c : costs[p] = new PluginCost();
        long repoInitMs = 0, loadedMs = 0, winnersMs = 0;
        string firstUsable = "?";

        foreach (var e in entries)
        {
            Match m;
            if ((m = Opened.Match(e.Message)).Success) { var c = Cost(m.Groups["p"].Value); c.ImportMs = Ms(m, "i"); c.MetadataMs = Ms(m, "m"); }
            else if ((m = Indexed.Match(e.Message)).Success) Cost(m.Groups["p"].Value).IndexMs = Ms(m, "ms");
            else if ((m = IndexPhases.Match(e.Message)).Success) { var c = Cost(m.Groups["p"].Value); c.DocumentsMs = Ms(m, "d"); c.PrepareMs = Ms(m, "pr"); c.AppendMs = Ms(m, "ap"); c.ExtractedMs = Ms(m, "e"); c.CommitMs = Ms(m, "c"); }
            else if ((m = Ingested.Match(e.Message)).Success) { var c = Cost(m.Groups["p"].Value); c.FromSource = true; c.DeserializeMs = Ms(m, "d"); c.ReconcileMs = Ms(m, "r"); }
            else if ((m = RepoInit.Match(e.Message)).Success) repoInitMs = Ms(m, "ms");
            else if ((m = Loaded.Match(e.Message)).Success) { loadedMs = Ms(m, "t"); winnersMs = Ms(m, "w"); firstUsable = m.Groups["f"].Value; }
        }

        // The regexes above parse the load path's own Debug lines; a wording change there must fail
        // here loudly rather than silently zero a phase.
        if (costs.Count == 0 || loadedMs == 0 || costs.Values.All(c => c.IndexMs == 0))
            throw new InvalidOperationException("No per-phase timing lines matched — the log texts in GameSession/SessionManager/DuckDbRecordIndex changed; update the regexes.");
        var records = session.Plugins.ToDictionary(p => p.Name, p => p.RecordCount, StringComparer.OrdinalIgnoreCase);
        var totalRecords = records.Values.Sum();
        var sb = new StringBuilder();
        sb.AppendLine("# Session-load profile (#113)");
        sb.AppendLine();
        sb.AppendLine(CultureInfo.InvariantCulture, $"- Instance: `{instanceRoot}` profile `{profile}`; Data: `{dataFolder}`");
        sb.AppendLine(CultureInfo.InvariantCulture, $"- Plugins: {explicitCount} explicit + forced masters/CC = {session.Plugins.Count} opened, {totalRecords:N0} records, {session.LoadFailures.Count} load failures");
        sb.AppendLine(CultureInfo.InvariantCulture, $"- Machine: {RuntimeInformation.OSDescription}, {Environment.ProcessorCount} logical cores, {RuntimeInformation.FrameworkDescription}");
        sb.AppendLine(CultureInfo.InvariantCulture, $"- Date: {DateTime.Now:yyyy-MM-dd}");
        sb.AppendLine();
        sb.AppendLine("## Totals");
        sb.AppendLine();
        sb.AppendLine("| Phase | ms | share |");
        sb.AppendLine("|---|---:|---:|");
        long openImport = costs.Values.Sum(c => c.ImportMs), openMeta = costs.Values.Sum(c => c.MetadataMs);
        long index = costs.Values.Sum(c => c.IndexMs), docs = costs.Values.Sum(c => c.DocumentsMs);
        long extracted = costs.Values.Sum(c => c.ExtractedMs), commit = costs.Values.Sum(c => c.CommitMs);
        long deser = costs.Values.Sum(c => c.DeserializeMs), reconcile = costs.Values.Sum(c => c.ReconcileMs);
        void Row(string name, long ms) => sb.AppendLine(CultureInfo.InvariantCulture, $"| {name} | {ms:N0} | {(wallMs > 0 ? 100.0 * ms / wallMs : 0):F1}% |");
        Row("Wall clock (LoadExplicit round trip)", wallMs);
        Row("DuckDB repository create (DDL + views)", repoInitMs);
        Row("Binary open — ModFactory.ImportGetter", openImport);
        Row("Binary open — BuildPluginMetadata (record count)", openMeta);
        Row("Index (all plugins)", index);
        Row("  ├ documents (enumerate + serialize + hash + refs + append)", docs);
        Row("  │  ├ parallel prepare (serialize, hash, refs, children)", costs.Values.Sum(c => c.PrepareMs));
        Row("  │  └ sequential append", costs.Values.Sum(c => c.AppendMs));
        Row("  ├ extracted tables (placement, header, lookup/refs/child flush)", extracted);
        Row("  └ commit", commit);
        Row("  tracked-only: source deserialize", deser);
        Row("  tracked-only: reconcile head", reconcile);
        Row("Winner sweep (UpdateWinners)", winnersMs);
        sb.AppendLine();
        sb.AppendLine(CultureInfo.InvariantCulture, $"Session fully loaded in {loadedMs:N0} ms; first plugin usable after {firstUsable} ms. " +
                      $"Unattributed (wall − repo − open − index − winners): {wallMs - repoInitMs - openImport - openMeta - index - winnersMs:N0} ms.");
        sb.AppendLine();
        sb.AppendLine("## Top 20 plugins by cost");
        sb.AppendLine();
        sb.AppendLine("| Plugin | records | open ms | index ms | documents | prepare | append | extracted | commit | src | total ms | µs/record |");
        sb.AppendLine("|---|---:|---:|---:|---:|---:|---:|---:|---:|:-:|---:|---:|");
        foreach (var (name, c) in costs.OrderByDescending(kv => kv.Value.TotalMs).Take(20))
        {
            var n = records.GetValueOrDefault(name);
            sb.AppendLine(CultureInfo.InvariantCulture, $"| {name} | {n:N0} | {c.OpenMs:N0} | {c.IndexMs:N0} | {c.DocumentsMs:N0} | {c.PrepareMs:N0} | {c.AppendMs:N0} | {c.ExtractedMs:N0} | {c.CommitMs:N0} | {(c.FromSource ? "src" : "bin")} | {c.TotalMs:N0} | {(n > 0 ? 1000.0 * c.TotalMs / n : 0):F0} |");
        }
        sb.AppendLine();
        sb.AppendLine("## Cost-per-record outliers (≥ 200 records, top 10 by µs/record)");
        sb.AppendLine();
        sb.AppendLine("| Plugin | records | total ms | µs/record |");
        sb.AppendLine("|---|---:|---:|---:|");
        foreach (var (name, c) in costs.Where(kv => records.GetValueOrDefault(kv.Key) >= 200)
                     .OrderByDescending(kv => (double)kv.Value.TotalMs / records[kv.Key]).Take(10))
        {
            var n = records[name];
            sb.AppendLine(CultureInfo.InvariantCulture, $"| {name} | {n:N0} | {c.TotalMs:N0} | {1000.0 * c.TotalMs / n:F0} |");
        }
        if (session.LoadFailures.Count > 0)
        {
            sb.AppendLine();
            sb.AppendLine("## Load failures");
            sb.AppendLine();
            foreach (var f in session.LoadFailures) sb.AppendLine(CultureInfo.InvariantCulture, $"- {f.Name}: {f.Reason}");
        }
        return sb.ToString();
    }

    private static long Ms(Match m, string group) => long.Parse(m.Groups[group].Value, CultureInfo.InvariantCulture);
}
