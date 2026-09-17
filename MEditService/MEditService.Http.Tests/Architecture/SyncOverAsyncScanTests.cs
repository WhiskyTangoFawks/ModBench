using System.Text.RegularExpressions;
using MEditService.Tests.TestSupport;

namespace MEditService.Tests.Architecture;

/// <summary>A task's result is reached by awaiting it. BannedSymbols.txt forbids `.Result`, and
/// these two spellings block the calling thread on the same hazard, so both are counted against an
/// allowlist that only shrinks.</summary>
public sealed class SyncOverAsyncScanTests
{
    // A Wait carrying a timeout asks whether the work arrived, which is a different question, so
    // only the no-argument form counts.
    private static readonly string[] Forms = ["GetAwaiter().GetResult()", ".Wait()"];

    // Each block leaves with the box ticket that rewrites its caller, so a failure reads as work
    // remaining rather than as a rule with no owner.
    private static readonly (string Root, string Ticket)[] Tickets =
    [
        ("MEditService.Codec", "#938"),
        ("MEditService.LoadOrder", "#938"),
        ("MEditService.PluginAdapter", "#938"),
        ("MEditService.SourceRepo", "#940"),
        ("MEditService.Index", "#941"),
        ("MEditService.Commands", "#943"),
        ("MEditService.Watcher", "#946"),
    ];

    // The ticket that empties the list, grows the ban with both forms and deletes this gate.
    private const string EndState = "#947";

    private const string AllowlistPath = "MEditService.Http.Tests/Architecture/sync-over-async-allowlist.txt";

    // Exact in both directions: a new block cannot hide inside a count already allowed, and a block
    // that has gone takes its line with it rather than pre-authorizing the next one.
    [Fact]
    public void TheSyncOverAsyncBlocks_AreExactlyTheAllowlist()
    {
        var root = ArchitectureTests.SolutionDirectory();

        var counts = Counts(root);
        var allowlist = Allowlist(root);
        var unallowed = counts.Except(allowlist, StringComparer.Ordinal).Order(StringComparer.Ordinal).ToList();
        var unmatched = allowlist.Except(counts, StringComparer.Ordinal).Order(StringComparer.Ordinal).ToList();

        Assert.True(
            unallowed.Count == 0 && unmatched.Count == 0,
            $"Sync-over-async blocks in production differ from {AllowlistPath}.\n"
            + $"Counts the allowlist does not name ({unallowed.Count}) — await the task instead; a "
            + "line is added here only on the maintainer's ruling:\n"
            + string.Join("\n", unallowed.Select(Ticketed))
            + $"\nAllowlist lines matching no count ({unmatched.Count}) — delete them; the list only "
            + "ever shrinks:\n"
            + string.Join("\n", unmatched));
    }

    // What makes the allowlist a countdown rather than a settlement: every line in it is a failure
    // naming the ticket that removes it.
    [Fact]
    public void TheAllowlist_IsEmpty()
    {
        var allowlist = Allowlist(ArchitectureTests.SolutionDirectory());

        Assert.True(
            allowlist.Count == 0,
            $"{allowlist.Count} sync-over-async blocks remain. Each holds a thread while a task runs, "
            + "which is what BannedSymbols.txt forbids under its other spelling. The ticket beside each "
            + $"line is the one that turns it green; the empty list, the ban and this gate's own "
            + $"deletion are {EndState}:\n"
            + string.Join("\n", allowlist.Select(Ticketed)));
    }

    // A line nobody owns is a line nobody removes.
    [Fact]
    public void EveryAllowlistLine_NamesABoxTicket()
    {
        var orphans = Allowlist(ArchitectureTests.SolutionDirectory())
            .Where(line => TicketFor(line) is null)
            .ToList();

        Assert.True(
            orphans.Count == 0,
            "An allowlist line sits under no project this gate knows a ticket for, so nothing says "
            + "who removes it:\n"
            + string.Join("\n", orphans));
    }

    // An empty allowlist and a scan that walked nothing read the same: this tells them apart, so a
    // roots typo cannot pass by finding nothing.
    [Fact]
    public void TheScan_WalksMoreThanOneHundredFiles()
    {
        var root = ArchitectureTests.SolutionDirectory();

        var walked = ScannedFiles(root).Count;

        Assert.True(walked > 100, $"The sync-over-async scan walked only {walked} production files.");
    }

    [Fact]
    public void TheScan_CountsPerFileAndForm_AndSkipsBuildOutputAndATimedWait()
    {
        var root = Directory.CreateTempSubdirectory("medit-sync-over-async-scan-").FullName;
        try
        {
            Directory.CreateDirectory(Path.Combine(root, "P", "obj"));
            File.WriteAllText(
                Path.Combine(root, "P", "Blocking.cs"),
                "var a = FirstAsync().GetAwaiter().GetResult();\nvar b = SecondAsync().GetAwaiter().GetResult();\n_gate.Wait();\n");
            File.WriteAllText(Path.Combine(root, "P", "Timed.cs"), "if (!gate.Wait(750)) return;");
            File.WriteAllText(Path.Combine(root, "P", "obj", "Generated.cs"), "x.GetAwaiter().GetResult();");
            File.WriteAllText(Path.Combine(root, "P", "Clean.cs"), "await FirstAsync();");

            Assert.Equal(
                ["P/Blocking.cs: .Wait(): 1", "P/Blocking.cs: GetAwaiter().GetResult(): 2"],
                Counts(root, ["P"]));
        }
        finally
        {
            Directory.Delete(root, recursive: true);
        }
    }

    [Fact]
    public void TicketFor_NamesTheProjectsTicket_AndNothingForAnUnknownProject()
    {
        Assert.Equal("#941", TicketFor("MEditService.Index/IndexProjector.cs: .Wait(): 1"));
        Assert.Equal("#938", TicketFor("MEditService.Codec/Schema/DeclaredDefaults.cs: GetAwaiter().GetResult(): 3"));
        Assert.Null(TicketFor("MEditService.Http/Program.cs: GetAwaiter().GetResult(): 1"));
        // A bare prefix match would hand a test project the production project's ticket.
        Assert.Null(TicketFor("MEditService.Index.Tests/Records/GateTests.cs: .Wait(): 1"));
    }

    private static string Ticketed(string line) => $"{line}   [{TicketFor(line) ?? "unowned"}]";

    private static string? TicketFor(string line) =>
        Array.Find(Tickets, t => line.StartsWith(t.Root + "/", StringComparison.Ordinal)).Ticket;

    private static IReadOnlyList<string> Allowlist(string root) =>
        SourceTree.ReadAllowlist(Path.Combine(root, AllowlistPath.Replace('/', Path.DirectorySeparatorChar)));

    private static List<string> Counts(string root) => Counts(root, ProductionRoots(root));

    // A count, not a line number: a block is the unit of work, and a line number would fail the gate
    // for any unrelated edit above one.
    private static List<string> Counts(string root, string[] scannedRoots) =>
        [.. ScannedFiles(root, scannedRoots)
            .SelectMany(file => Forms
                .Select(form => (Form: form, Count: Regex.Count(File.ReadAllText(file), Regex.Escape(form))))
                .Where(hit => hit.Count > 0)
                .Select(hit => $"{Path.GetRelativePath(root, file).Replace(Path.DirectorySeparatorChar, '/')}: {hit.Form}: {hit.Count}"))
            .Order(StringComparer.Ordinal)];

    private static List<string> ScannedFiles(string root) => ScannedFiles(root, ProductionRoots(root));

    private static List<string> ScannedFiles(string root, string[] scannedRoots) =>
        [.. scannedRoots.SelectMany(r => SourceTree.CSharpFiles(Path.Combine(root, r)))];

    // Read from disk, so a box added to the solution is scanned without a list here going stale.
    private static string[] ProductionRoots(string root) => [.. ServiceProjects.Production(root)];
}
