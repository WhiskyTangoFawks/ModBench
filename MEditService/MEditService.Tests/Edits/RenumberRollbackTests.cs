using MEditService.Core.Edits;
using MEditService.Core.Plugins;
using MEditService.Core.Records;
using MEditService.Core.Schema;
using MEditService.Core.Source;
using MEditService.Tests.TestSupport;
using Microsoft.Extensions.Logging.Abstractions;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;
using Mutagen.Bethesda.Plugins.Records;

namespace MEditService.Tests.Edits;

/// <summary>
/// #678 (ADR-0045): a renumber that fails part-way leaves the author's working trees as they were.
///
/// <para><b>The fault is a failing index write, and it is realistic.</b> The cascade's phase two is a
/// sequence of (write the file, tell the index what landed) pairs, and the index half is DuckDB — it
/// can fail on a full or failing device the same as any other write. Injecting there rather than at
/// the file write is also the <i>harder</i> case for the rollback, not the easier one: the file write
/// at that position has already succeeded and durably landed, so every position in the sweep leaves
/// real bytes on disk that have to be taken back off again. A fault at the file write would leave the
/// last position with nothing to undo.</para>
///
/// <para><b>Two oracles, deliberately.</b> Every "unchanged" assertion compares a direct filesystem
/// snapshot (<see cref="TreeSnapshot"/>: path set, content hash, and the directory list including
/// empty directories) <i>and</i> the repository's own <c>git status</c>. They are not redundant:
/// <see cref="TheDirectFilesystemOracleSeesAnEmptyDirectory_WhichGitStatusCallsClean"/> demonstrates
/// the disagreement in the direction that matters — git reports clean over debris the filesystem
/// snapshot catches, which is precisely the class of damage #675 was about.</para>
///
/// <para><b>The seam is <see cref="IRecordIndex"/>, not something added for the test.</b> It is the
/// interface the service already writes through, substituted through the existing
/// <see cref="DelegatingRecordIndex"/>/<see cref="IndexOverridingMirror"/> pair. Nothing in production
/// knows this test exists.</para>
/// </summary>
public sealed class RenumberRollbackTests
{
    private static RecordEditService ServiceFor(ILoadOrderMirror mirror) =>
        new(mirror, SharedSchemaReflector.Instance, NullLogger<RecordEditService>.Instance);

    // ---- the sweep ----

    /// <summary>
    /// The centrepiece: fail the cascade at each of its writes in turn and assert every affected
    /// source tree is byte-identical to its pre-action state every time. The number of positions is
    /// counted off one clean run rather than written down here, so a cascade that grows a write grows
    /// the sweep with it instead of quietly escaping it.
    ///
    /// <para><b>A position here is one cascade <i>write step</i></b> — one rewritten referencing file,
    /// or the renumbered record's own delete+create — not one filesystem act. A step is a pair (put
    /// the bytes on disk, tell the index what landed) and the fault lands on the second half, so the
    /// step's file work has completed when it fires. The acts <i>within</i> the target's step (the
    /// container's move, the new leaf, the old leaf's delete, the ordering renames) are swept
    /// individually by <see cref="Source.SourceWriteTransactionTests"/>, over the same act sequence in
    /// a scratch tree — sweeping them from here would need a fault hook inside the write itself, which
    /// is machinery in the production seam for a test's sake.</para>
    /// </summary>
    [Fact]
    public void FailingTheCascadeAtEachWriteInTurn_LeavesEverySourceTreeUnchanged()
    {
        int positions;
        using (var probe = new CascadeRollbackFixture())
        {
            var counter = new CountingIndex(probe.Mirror.Index!);
            var applied = ServiceFor(new IndexOverridingMirror(probe.Mirror, counter))
                .RenumberRecord(probe.TargetPlugin, probe.Race.ToString());
            Assert.True(applied.Applied, applied.Message);
            positions = counter.Writes;
        }

        // Three referencing files across three separate tracked mods, plus the renumbered record's
        // own delete+create. If this ever drops to one the sweep has stopped proving anything.
        Assert.True(positions >= 4, $"the cascade should span several writes; counted {positions}");

        for (var failAt = 0; failAt < positions; failAt++)
        {
            using var fixture = new CascadeRollbackFixture();
            var before = fixture.Snapshots();
            var statusBefore = fixture.GitStatuses();

            var failing = new FailingIndex(fixture.Mirror.Index!, failAt);
            var thrown = Assert.Throws<IOException>(() =>
                ServiceFor(new IndexOverridingMirror(fixture.Mirror, failing))
                    .RenumberRecord(fixture.TargetPlugin, fixture.Race.ToString()));

            Assert.True(failing.Fired, $"the injected failure never fired at position {failAt}");
            Assert.Equal(before, fixture.Snapshots());
            Assert.Equal(statusBefore, fixture.GitStatuses());

            // No message names a repository holding partial damage, because there is none.
            Assert.Contains("back as it was — nothing to review or revert", thrown.Message, StringComparison.Ordinal);
            Assert.DoesNotContain("review and revert in the Source Control panel", thrown.Message, StringComparison.Ordinal);
        }
    }

    /// <summary>
    /// The same guarantee when the <i>file</i> write is what throws, rather than the index write after
    /// it. The obstruction is real and needs no seam at all: another tool has put a directory where
    /// one referencer's source file stood, so the cascade computes that record from the indexed body
    /// (<c>ReadRecordFromSource</c>'s documented missing-file fallback) and then cannot rename onto
    /// the path. Whichever writes landed before it come back off.
    /// </summary>
    [Fact]
    public void ACascadeWhoseFileWriteThrows_StillLeavesEverySourceTreeUnchanged()
    {
        using var fixture = new CascadeRollbackFixture();
        var blocked = fixture.SourceFileOf(fixture.SecondPlugin, fixture.SecondNpc, "npc_", CascadeRollbackFixture.SecondNpcEditorId);
        File.Delete(blocked);
        Directory.CreateDirectory(blocked);

        var before = fixture.Snapshots();

        var thrown = Assert.Throws<IOException>(() =>
            ServiceFor(fixture.Mirror).RenumberRecord(fixture.TargetPlugin, fixture.Race.ToString()));

        Assert.Contains("back as it was", thrown.Message, StringComparison.Ordinal);
        Assert.Equal(before, fixture.Snapshots());
    }

    // ---- the conditional half of the guarantee ----

    /// <summary>
    /// A third party overwrites one of the files the cascade already wrote, before the failure. Its
    /// bytes are kept, every other file is restored, and the error names that file and only that
    /// file — by its path relative to the mod folder, never an absolute one.
    ///
    /// <para>The write is genuinely made to the real file by this process; the index seam is only what
    /// schedules it between the cascade's write and its rollback.</para>
    /// </summary>
    [Fact]
    public void AFileAThirdPartyOverwroteAfterTheWrite_KeepsTheirBytes_AndIsTheOnlyOneNamed()
    {
        using var fixture = new CascadeRollbackFixture();
        var contested = fixture.SourceFileOf(fixture.FirstPlugin, fixture.FirstNpc, "npc_", CascadeRollbackFixture.FirstNpcEditorId);
        const string Interloper = "{ \"written\": \"by something else\" }";

        var quiet = fixture.SourceFileOf(fixture.SecondPlugin, fixture.SecondNpc, "npc_", CascadeRollbackFixture.SecondNpcEditorId);
        var quietBefore = File.ReadAllText(quiet);

        // Fail late enough that every referencing file has been written, and overwrite one of them
        // on the way out.
        var failing = new FailingIndex(fixture.Mirror.Index!, failAt: 3)
        {
            BeforeThrowing = () => File.WriteAllText(contested, Interloper),
        };
        var thrown = Assert.Throws<IOException>(() =>
            ServiceFor(new IndexOverridingMirror(fixture.Mirror, failing))
                .RenumberRecord(fixture.TargetPlugin, fixture.Race.ToString()));

        Assert.Equal(Interloper, File.ReadAllText(contested));
        Assert.Equal(quietBefore, File.ReadAllText(quiet));

        var named = Path.GetRelativePath(fixture.ModFolderOf(fixture.FirstPlugin), contested).Replace('\\', '/');
        Assert.Contains(named, thrown.Message.Replace('\\', '/'), StringComparison.Ordinal);
        Assert.Contains("changed by something else", thrown.Message, StringComparison.Ordinal);
        // Only that file. The neighbour that was quietly restored is not on the list.
        Assert.DoesNotContain(CascadeRollbackFixture.SecondNpcEditorId, thrown.Message, StringComparison.Ordinal);
        // Relative, not absolute: the mod folder's own path never reaches the author.
        Assert.DoesNotContain(fixture.ModFolderOf(fixture.FirstPlugin), thrown.Message, StringComparison.Ordinal);
    }

    /// <summary>A third party deletes a file the cascade wrote. It is not resurrected, and it is
    /// named.</summary>
    [Fact]
    public void AFileAThirdPartyDeletedAfterTheWrite_IsNotResurrected_AndIsNamed()
    {
        using var fixture = new CascadeRollbackFixture();
        var removed = fixture.SourceFileOf(fixture.FirstPlugin, fixture.FirstNpc, "npc_", CascadeRollbackFixture.FirstNpcEditorId);

        var failing = new FailingIndex(fixture.Mirror.Index!, failAt: 3)
        {
            BeforeThrowing = () => File.Delete(removed),
        };
        var thrown = Assert.Throws<IOException>(() =>
            ServiceFor(new IndexOverridingMirror(fixture.Mirror, failing))
                .RenumberRecord(fixture.TargetPlugin, fixture.Race.ToString()));

        Assert.False(File.Exists(removed));
        var named = Path.GetRelativePath(fixture.ModFolderOf(fixture.FirstPlugin), removed).Replace('\\', '/');
        Assert.Contains(named, thrown.Message.Replace('\\', '/'), StringComparison.Ordinal);
        Assert.Contains("removed by something else", thrown.Message, StringComparison.Ordinal);
    }

    // ---- ordering prefixes, containers, and the index ----

    /// <summary>
    /// The renumber's delete+create renames the group's ordering prefixes as its own last act. Those
    /// renames are part of what a failure has to put back — undone in reverse, so nothing is ever
    /// asked to move into a name a sibling still occupies.
    /// </summary>
    [Fact]
    public void GroupOrderingPrefixesReturnToTheirPreActionValues()
    {
        using var fixture = new CascadeRollbackFixture();
        var racesFolder = Path.GetDirectoryName(
            fixture.SourceFileOf(fixture.TargetPlugin, fixture.Race, "race", CascadeRollbackFixture.RaceEditorId))!;
        var before = Directory.GetFileSystemEntries(racesFolder).Select(Path.GetFileName).Order(StringComparer.Ordinal).ToList();
        Assert.Contains(before, name => name!.StartsWith('['));

        var failing = new FailingIndex(fixture.Mirror.Index!, failAt: 3);
        Assert.Throws<IOException>(() =>
            ServiceFor(new IndexOverridingMirror(fixture.Mirror, failing))
                .RenumberRecord(fixture.TargetPlugin, fixture.Race.ToString()));

        Assert.Equal(
            before, Directory.GetFileSystemEntries(racesFolder).Select(Path.GetFileName).Order(StringComparer.Ordinal).ToList());
    }

    /// <summary>
    /// A container renumber moves the record's whole directory — its folder-split children with it —
    /// before writing its fields. A failure after that has the subtree put back, children and all.
    /// </summary>
    [Fact]
    public void AContainerRenumberFailingAfterRelocatingItsSubtree_PutsTheSubtreeBack()
    {
        using var fixture = new ContainerModFixture();
        var before = TreeSnapshot.Of(fixture.ModFolder);
        var statusBefore = fixture.GitStatus();

        // The quest's own ApplyRenumber is the last act of its write, so everything the file side of
        // the cascade does — the Directory.Move included — has already happened when this fires.
        var failing = new FailingIndex(fixture.Mirror.Index!, failAt: 0);
        Assert.Throws<IOException>(() =>
            ServiceFor(new IndexOverridingMirror(fixture.Mirror, failing))
                .RenumberRecord(fixture.Plugin, fixture.Quest.ToString()));

        Assert.True(failing.Fired);
        Assert.Equal(before, TreeSnapshot.Of(fixture.ModFolder));
        Assert.Equal(statusBefore, fixture.GitStatus());
    }

    /// <summary>
    /// After a rolled-back renumber the index answers the old identity and nothing at the new one —
    /// containment and cell location included. The index is not unwound row by row: the affected
    /// plugins are re-derived from their restored source trees (#672), which is the only reading of
    /// "put it back" that cannot drift from what the files actually say.
    /// </summary>
    [Fact]
    public void AfterARolledBackRenumber_TheIndexAnswersTheOldIdentityAndNothingAtTheNewOne()
    {
        using var fixture = new ContainerModFixture();
        var quest = fixture.Quest.ToString();
        var topic = fixture.DialogTopic.ToString();

        var failing = new FailingIndex(fixture.Mirror.Index!, failAt: 0);
        Assert.Throws<IOException>(() =>
            ServiceFor(new IndexOverridingMirror(fixture.Mirror, failing))
                .RenumberRecord(fixture.Plugin, quest));

        var reads = fixture.Mirror.Index!.At(RecordRef.Effective);
        Assert.NotNull(reads.GetDocument(quest, fixture.Plugin));
        Assert.Equal(quest, reads.GetContainerParent(fixture.Plugin, topic)?.ParentFormKey);

        var cell = fixture.TopCell.ToString();
        Assert.Equal(fixture.Worldspace.ToString(), reads.GetCellLocation(fixture.Plugin, cell)?.ParentWorldspace);
    }

    /// <summary>
    /// A rolled-back <i>cascade</i> leaves the reference graph naming the old FormKey, not the new
    /// one — the half that is not free. The referencing files were rewritten and their index rows
    /// updated before the failure; only re-deriving those plugins from their restored trees puts the
    /// graph back. Drop the re-ingest from <c>RollBackFailedRenumber</c> and this is the assertion
    /// that goes red.
    /// </summary>
    [Fact]
    public void AfterARolledBackCascade_TheReferenceGraphStillNamesTheOldFormKey()
    {
        using var fixture = new CascadeRollbackFixture();
        var race = fixture.Race.ToString();

        var failing = new FailingIndex(fixture.Mirror.Index!, failAt: 3);
        var thrown = Assert.Throws<IOException>(() =>
            ServiceFor(new IndexOverridingMirror(fixture.Mirror, failing))
                .RenumberRecord(fixture.TargetPlugin, race));

        var reads = fixture.Mirror.Index!.At(RecordRef.Effective);
        Assert.Equal(3, reads.GetReferencedBy(race).Select(r => r.FormKey).Distinct().Count());

        // And nothing at the identity the renumber was reaching for.
        var newFormKey = ExtractNewFormKey(thrown.Message, race);
        Assert.Null(reads.GetDocument(newFormKey, fixture.TargetPlugin));
        Assert.Empty(reads.GetReferencedBy(newFormKey));
    }

    /// <summary>"Renumbering &lt;old&gt; to &lt;new&gt; failed." — the message states the identity the
    /// action was reaching for, which is the only place a test can learn it once the action has been
    /// undone.</summary>
    private static string ExtractNewFormKey(string message, string oldFormKey)
    {
        var after = message[(message.IndexOf($"{oldFormKey} to ", StringComparison.Ordinal) + oldFormKey.Length + 4)..];
        return after[..after.IndexOf(' ')];
    }

    // ---- the two oracles ----

    /// <summary>
    /// Why <see cref="TreeSnapshot"/> stands beside <c>git status</c> rather than being replaced by
    /// it. Git tracks files, not directories, so an empty record directory left behind in a source
    /// tree is invisible to the repository's own status — and that is exactly the debris #675 exists
    /// to prevent, since it occupies an ordering slot and fails the next whole-plugin ingest. The two
    /// oracles disagree here, in the direction that matters: the direct comparison catches what git
    /// calls clean.
    /// </summary>
    [Fact]
    public void TheDirectFilesystemOracleSeesAnEmptyDirectory_WhichGitStatusCallsClean()
    {
        using var fixture = new ContainerModFixture();
        var snapshotBefore = TreeSnapshot.Of(fixture.ModFolder);
        var statusBefore = fixture.GitStatus();

        Directory.CreateDirectory(Path.Combine(fixture.SourceRoot, "[9] Stray Record Directory"));

        Assert.Equal(statusBefore, fixture.GitStatus());
        Assert.NotEqual(snapshotBefore, TreeSnapshot.Of(fixture.ModFolder));
    }

    // ---- doubles ----

    /// <summary>Counts the index writes the cascade makes — one per rewritten referencing file, one
    /// for the renumbered record itself — so the sweep's position count comes off a real run.</summary>
    private sealed class CountingIndex(IRecordIndex inner) : DelegatingRecordIndex(inner)
    {
        public int Writes { get; private set; }

        public override void ApplyWorkingTreeChanges(PluginKey key, IReadOnlyList<(string FormKey, string? Body)> deltas)
        {
            Writes++;
            base.ApplyWorkingTreeChanges(key, deltas);
        }

        public override void ApplyRenumber(PluginKey key, RenumberedRecord renumbered)
        {
            Writes++;
            base.ApplyRenumber(key, renumbered);
        }
    }

    /// <summary>The same count, throwing at one chosen position instead of passing it through — the
    /// device-level failure a DuckDB write can genuinely take, arriving after that position's source
    /// file has already landed on disk.</summary>
    private sealed class FailingIndex(IRecordIndex inner, int failAt) : DelegatingRecordIndex(inner)
    {
        private int _seen;

        public bool Fired { get; private set; }

        /// <summary>Run in the failing call, before it throws — the window in which a third party's
        /// own write to an already-written file is genuinely concurrent with this action.</summary>
        public Action? BeforeThrowing { get; init; }

        public override void ApplyWorkingTreeChanges(PluginKey key, IReadOnlyList<(string FormKey, string? Body)> deltas)
        {
            if (ShouldFail()) return;
            base.ApplyWorkingTreeChanges(key, deltas);
        }

        public override void ApplyRenumber(PluginKey key, RenumberedRecord renumbered)
        {
            if (ShouldFail()) return;
            base.ApplyRenumber(key, renumbered);
        }

        private bool ShouldFail()
        {
            if (_seen++ != failAt) return false;
            Fired = true;
            BeforeThrowing?.Invoke();
            throw new IOException("the index device reported a write failure");
        }
    }

    // ---- the fixture ----

    /// <summary>
    /// Three tracked mods, each its own folder and its own repository, one referencing record apiece
    /// pointing at a Race in the first — the shape AC1 is about, since a cascade that spans one mod
    /// folder cannot show that a failure leaves <i>several</i> working trees as they were. The
    /// referencing records are of a different type from the target, so each write lands in its own
    /// group folder and a failure at one position is visibly distinct from a failure at another.
    /// </summary>
    private sealed class CascadeRollbackFixture : IDisposable
    {
        public const string RaceEditorId = "RollbackRace";
        public const string HomeNpcEditorId = "HomeNpc";
        public const string FirstNpcEditorId = "FirstNpc";
        public const string SecondNpcEditorId = "SecondNpc";

        private const string TargetName = "Target.esp";
        private const string FirstName = "First.esp";
        private const string SecondName = "Second.esp";

        private readonly ScatteredFixtureData _data;

        public LoadOrderMirror Mirror { get; }
        public PluginKey TargetPlugin { get; } = new(TargetName, "TargetMod");
        public PluginKey FirstPlugin { get; } = new(FirstName, "FirstMod");
        public PluginKey SecondPlugin { get; } = new(SecondName, "SecondMod");

        public FormKey Race { get; }
        public FormKey FirstNpc { get; }
        public FormKey SecondNpc { get; }

        public CascadeRollbackFixture()
        {
            FormKey race = default;
            FormKey first = default;
            FormKey second = default;

            _data = new PluginFixtureBuilder("medit-renumber-rollback")
                .WithPlugin(TargetName, mod =>
                {
                    var added = mod.Races.AddNew(RaceEditorId);
                    race = added.FormKey;
                    mod.Npcs.AddNew(HomeNpcEditorId).Race.SetTo(added);
                }, origin: TargetMod)
                .WithPlugin(FirstName, mod =>
                {
                    mod.ModHeader.MasterReferences.Add(new MasterReference { Master = ModKey.FromFileName(TargetName) });
                    var npc = mod.Npcs.AddNew(FirstNpcEditorId);
                    npc.Race.SetTo(race);
                    first = npc.FormKey;
                }, origin: FirstMod)
                .WithPlugin(SecondName, mod =>
                {
                    mod.ModHeader.MasterReferences.Add(new MasterReference { Master = ModKey.FromFileName(TargetName) });
                    var npc = mod.Npcs.AddNew(SecondNpcEditorId);
                    npc.Race.SetTo(race);
                    second = npc.FormKey;
                }, origin: SecondMod)
                .BuildScattered();

            (Race, FirstNpc, SecondNpc) = (race, first, second);

            Mirror = new LoadOrderMirror(
                new DuckDbRecordIndexFactory(SharedSchemaReflector.Instance, new TableDdlBuilder(SharedSchemaReflector.Instance)));
            ((ILoadOrderMirror)Mirror).Reconcile(_data.GameDirectory, _data.Plugins, GameRelease.Fallout4);

            var track = new TrackService(NullLogger<TrackService>.Instance);
            foreach (var origin in new[] { TargetMod, FirstMod, SecondMod })
                track.TrackAsync(Mirror.LoadOrder!, origin, SourcePreset.Edits).GetAwaiter().GetResult();
        }

        private const string TargetMod = "TargetMod";
        private const string FirstMod = "FirstMod";
        private const string SecondMod = "SecondMod";

        public string ModFolderOf(PluginKey plugin) => ModFolders.Of(Mirror.LoadOrder, plugin)!;

        public string SourceFileOf(PluginKey plugin, FormKey formKey, string recordType, string editorId) =>
            SourceUnitResolver.FlatSourcePath(
                ModFolderOf(plugin), plugin.Name, recordType, formKey.ToString(), editorId, GameRelease.Fallout4);

        /// <summary>Every tracked tree, by mod folder — the direct oracle, which sees empty
        /// directories.</summary>
        public IReadOnlyDictionary<string, IReadOnlyList<string>> Snapshots() =>
            AllPlugins.ToDictionary(p => p.Name, p => TreeSnapshot.Of(ModFolderOf(p)));

        /// <summary>The same trees through each repository's own porcelain status — the independent
        /// oracle, which does not.</summary>
        public IReadOnlyDictionary<string, IReadOnlyList<string>> GitStatuses() =>
            AllPlugins.ToDictionary(
                p => p.Name,
                IReadOnlyList<string> (p) => GitCli
                    .Run(Path.Combine(ModFolderOf(p), ".git"), ModFolderOf(p), "status", "--porcelain")
                    .Split('\n', StringSplitOptions.RemoveEmptyEntries)
                    .Select(l => l.Trim())
                    .ToList());

        private PluginKey[] AllPlugins => [TargetPlugin, FirstPlugin, SecondPlugin];

        public void Dispose()
        {
            Mirror.Dispose();
            try { _data.Dispose(); }
            catch (IOException) { /* scratch directory, best effort */ }
            catch (UnauthorizedAccessException) { /* ditto */ }
        }
    }
}
