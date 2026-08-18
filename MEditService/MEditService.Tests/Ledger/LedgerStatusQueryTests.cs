using MEditService.Core.Ledger;
using MEditService.Core.Session;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Logging.Abstractions;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Plugins;
using Mutagen.Bethesda.Plugins.Records;

namespace MEditService.Tests.Ledger;

/// <summary>
/// #368 review (correctness + mutation axes): <see cref="LedgerStatusQuery.GetWorkingTreeChanges"/>'s
/// three skip branches (an origin never vendored into, a status line that doesn't parse as a record
/// path, a record whose plugin left the load order) and its per-origin failure isolation — none had
/// direct coverage before this, which is exactly how the non-ASCII quoting bug (a real instance of
/// the second branch) reached production with nothing failing. Real <see cref="LedgerRepository"/>
/// and real git throughout (via its own primitives, bypassing <see cref="RecordVendor"/>/the codec —
/// this seam only needs *some* tracked+dirty ledger file, not a faithfully serialized record),
/// mirroring <see cref="LedgerGroupCommitterTests"/>'s own seam choice.
/// </summary>
public sealed class LedgerStatusQueryTests
{
    private static LedgerRepository NewLedger(out string ledgerRoot)
    {
        ledgerRoot = Directory.CreateTempSubdirectory("medit-ledger-status-query-").FullName;
        return new LedgerRepository(new LedgerOptions(ledgerRoot), NullLogger<LedgerRepository>.Instance);
    }

    private static string NewOriginFolder(string prefix) =>
        Directory.CreateTempSubdirectory($"medit-origin-{prefix}-").FullName;

    // Vendors a tracked, dirty record directly through LedgerRepository's own stage/commit
    // primitives, at an arbitrary relative path — bypasses RecordVendor/the codec entirely, so it
    // can also plant a path LedgerRecordPath.For would never itself produce (the malformed-path
    // test below needs exactly that).
    private static void VendorDirtyFile(LedgerRepository ledger, string originFolder, string relativePath, string pristine, string dirty)
    {
        ledger.EnsureRepo(originFolder);
        var absolutePath = Path.Combine(originFolder, relativePath);
        Directory.CreateDirectory(Path.GetDirectoryName(absolutePath)!);
        File.WriteAllText(absolutePath, pristine);
        ledger.StagePath(originFolder, relativePath);
        ledger.CommitStaged(originFolder, "vendor: test fixture");
        File.WriteAllText(absolutePath, dirty);
    }

    private static void VendorDirtyRecord(LedgerRepository ledger, string originFolder, string pluginFileName, string recordType, string formKey) =>
        VendorDirtyFile(ledger, originFolder, LedgerRecordPath.For(pluginFileName, recordType, formKey),
            $"FormKey: {formKey}\n", $"FormKey: {formKey}\nAggression: Frenzied\n");

    private static PluginMetadata Plugin(string name, string origin, string path) =>
        new(name, path, LoadOrderIndex: 0, IsLight: false, IsMaster: false, Masters: [], RecordCount: 0,
            IsImmutable: false, Origin: origin, Participates: true, InLoadOrder: true);

    private sealed class StubGameSession(IReadOnlyList<PluginMetadata> plugins) : IGameSession
    {
        public IReadOnlyList<PluginMetadata> Plugins => plugins;
        public IReadOnlyList<PluginLoadFailure> LoadFailures => [];
        public string DataFolderPath => throw new NotSupportedException();
        public GameRelease GameRelease => throw new NotSupportedException();
        public string? FilterSql { get => throw new NotSupportedException(); set => throw new NotSupportedException(); }
        public IModGetter? GetMod(string pluginName, string origin) => throw new NotSupportedException();
        public PluginMetadata AddPlugin(string filePath) => throw new NotSupportedException();
        public PluginMetadata AddUnlistedPlugin(string filePath, string origin, int loadOrderIndex) => throw new NotSupportedException();
        public bool RemoveUnlistedPlugin(string pluginName, string origin) => throw new NotSupportedException();
        public void Dispose() { }
    }

    private sealed class CapturingLogger : ILogger<LedgerStatusQuery>
    {
        public List<(LogLevel Level, string Message)> Entries { get; } = [];
        public IDisposable? BeginScope<TState>(TState state) where TState : notnull => null;
        public bool IsEnabled(LogLevel logLevel) => true;
        public void Log<TState>(LogLevel logLevel, EventId eventId, TState state, Exception? exception,
            Func<TState, Exception?, string> formatter) =>
            Entries.Add((logLevel, formatter(state, exception)));
    }

    [Fact]
    public void NullSession_ReturnsEmptyWithoutThrowing()
    {
        var ledger = NewLedger(out var ledgerRoot);
        try
        {
            var query = new LedgerStatusQuery(ledger, NullLogger<LedgerStatusQuery>.Instance);
            Assert.Empty(query.GetWorkingTreeChanges(null));
        }
        finally { Directory.Delete(ledgerRoot, recursive: true); }
    }

    // Skip branch 1: an origin folder the session names but that was never vendored into at all —
    // the ordinary, common case (nothing from that plugin has ever been edited).
    [Fact]
    public void OriginNeverVendoredInto_ContributesNoEntries_OtherOriginsStillReported()
    {
        var ledger = NewLedger(out var ledgerRoot);
        try
        {
            var query = new LedgerStatusQuery(ledger, NullLogger<LedgerStatusQuery>.Instance);

            var untouchedOrigin = NewOriginFolder("untouched"); // no EnsureRepo call at all
            var vendoredOrigin = NewOriginFolder("vendored");
            VendorDirtyRecord(ledger, vendoredOrigin, "Vendor.esp", "npc_", "000800:Vendor.esp");

            var session = new StubGameSession([
                Plugin("Untouched.esp", "UntouchedMod", Path.Combine(untouchedOrigin, "Untouched.esp")),
                Plugin("Vendor.esp", "VendorMod", Path.Combine(vendoredOrigin, "Vendor.esp")),
            ]);

            var entries = query.GetWorkingTreeChanges(session);

            var entry = Assert.Single(entries);
            Assert.Equal("Vendor.esp", entry.Plugin);
        }
        finally { Directory.Delete(ledgerRoot, recursive: true); }
    }

    // Skip branch 2 (the one that swallowed the non-ASCII bug, review finding 1): a genuine git
    // status line under *.ledger/* whose path doesn't parse as a record — must be skipped *and*
    // logged, not silently dropped with nothing anywhere saying so.
    [Fact]
    public void MalformedLedgerPath_IsSkippedAndLogged_OtherRecordsInTheSameOriginStillReported()
    {
        var ledger = NewLedger(out var ledgerRoot);
        try
        {
            var logger = new CapturingLogger();
            var query = new LedgerStatusQuery(ledger, logger);

            var origin = NewOriginFolder("malformed");
            // Two segments under the .ledger root, not the required three (recordType/originModKey/
            // file) — a path *.ledger/* still matches (git status still reports it) but TryParse
            // rejects on segment count. Planted directly (VendorDirtyFile, not VendorDirtyRecord) —
            // LedgerRecordPath.For itself could never produce this shape.
            var malformedRelativePath = Path.Combine("Vendor.esp.ledger", "not-a-real-record.yaml");
            VendorDirtyFile(ledger, origin, malformedRelativePath, "pristine\n", "dirty\n");
            VendorDirtyRecord(ledger, origin, "Vendor.esp", "npc_", "000800:Vendor.esp");

            var session = new StubGameSession([Plugin("Vendor.esp", "VendorMod", Path.Combine(origin, "Vendor.esp"))]);

            var entries = query.GetWorkingTreeChanges(session);

            var entry = Assert.Single(entries);
            Assert.Equal("000800:Vendor.esp", entry.FormKey);
            Assert.Contains(logger.Entries, e => e.Level == LogLevel.Warning && e.Message.Contains("not-a-real-record.yaml", StringComparison.Ordinal));
        }
        finally { Directory.Delete(ledgerRoot, recursive: true); }
    }

    // Skip branch 3: a record whose ledger path parses cleanly but names a plugin the current
    // session no longer lists in the load order (renamed away, dropped from plugins.txt) — a
    // legitimate state, not a failure, so no log is asserted here, only the skip.
    [Fact]
    public void RecordForAPluginNoLongerInTheLoadOrder_IsSkippedWithoutThrowing()
    {
        var ledger = NewLedger(out var ledgerRoot);
        try
        {
            var query = new LedgerStatusQuery(ledger, NullLogger<LedgerStatusQuery>.Instance);

            var origin = NewOriginFolder("shared");
            // Both plugins vendor into the same physical origin folder (one origin folder can host
            // more than one plugin's own .ledger tree, LedgerGroupCommitter's own class remarks) —
            // only "Current.esp" is in the session; "Ghost.esp" no longer is.
            VendorDirtyRecord(ledger, origin, "Current.esp", "npc_", "000800:Current.esp");
            VendorDirtyRecord(ledger, origin, "Ghost.esp", "npc_", "000801:Ghost.esp");

            var session = new StubGameSession([Plugin("Current.esp", "SharedMod", Path.Combine(origin, "Current.esp"))]);

            var entries = query.GetWorkingTreeChanges(session);

            var entry = Assert.Single(entries);
            Assert.Equal("Current.esp", entry.Plugin);
        }
        finally { Directory.Delete(ledgerRoot, recursive: true); }
    }

    // Per-origin failure isolation (review finding 6): a genuinely broken repo (a real git failure —
    // corrupted HEAD, never mocked) must not blank the panel for every other, unaffected origin.
    [Fact]
    public void OneOriginsGitReadFails_OtherOriginsStillReported_AndTheFailureIsLogged()
    {
        var ledger = NewLedger(out var ledgerRoot);
        try
        {
            var logger = new CapturingLogger();
            var query = new LedgerStatusQuery(ledger, logger);

            var goodOrigin = NewOriginFolder("good");
            VendorDirtyRecord(ledger, goodOrigin, "Vendor.esp", "npc_", "000800:Vendor.esp");

            var brokenOrigin = NewOriginFolder("broken");
            ledger.EnsureRepo(brokenOrigin);
            var (brokenGitDir, _) = ledger.PathsFor(brokenOrigin);
            // A real git failure, not a mock: corrupting HEAD after a valid init makes every later
            // `git status` against this gitdir fail with a genuine non-zero exit (confirmed
            // empirically: "fatal: not a git repository", exit 128).
            File.WriteAllText(Path.Combine(brokenGitDir, "HEAD"), "not a ref\n");

            var session = new StubGameSession([
                Plugin("Vendor.esp", "VendorMod", Path.Combine(goodOrigin, "Vendor.esp")),
                Plugin("Broken.esp", "BrokenMod", Path.Combine(brokenOrigin, "Broken.esp")),
            ]);

            var entries = query.GetWorkingTreeChanges(session);

            var entry = Assert.Single(entries);
            Assert.Equal("Vendor.esp", entry.Plugin);
            Assert.Contains(logger.Entries, e => e.Level == LogLevel.Warning && e.Message.Contains(brokenOrigin, StringComparison.Ordinal));
        }
        finally { Directory.Delete(ledgerRoot, recursive: true); }
    }
}
