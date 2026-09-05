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

/// <summary>A renumber that fails part-way leaves the working trees as they were (ADR-0045).</summary>
public sealed class RenumberRollbackTests
{
    private static RecordEditService ServiceFor(ILoadOrderMirror mirror) =>
        new(mirror, SharedSchemaReflector.Instance, NullLogger<RecordEditService>.Instance);

    // ---- the sweep ----

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

    // ---- ordering, containers, and the index ----

    [Fact]
    public void TheParentsOrderedChildList_ReturnsToItsPreActionValue()
    {
        using var fixture = new CascadeRollbackFixture();
        var racesFolder = Path.GetDirectoryName(
            fixture.SourceFileOf(fixture.TargetPlugin, fixture.Race, "Race", CascadeRollbackFixture.RaceEditorId))!;

        var carrier = SourceChildOrder.CarrierFor(racesFolder, parentIsRecord: false);
        var orderBefore = File.ReadAllBytes(carrier);
        Assert.Contains(fixture.Race.ToString(), SourceChildOrder.ListAt(carrier, "Races"), StringComparer.Ordinal);

        var entriesBefore = Directory.GetFileSystemEntries(racesFolder)
            .Select(Path.GetFileName).Order(StringComparer.Ordinal).ToList();

        var failing = new FailingIndex(fixture.Mirror.Index!, failAt: 3);
        Assert.Throws<IOException>(() =>
            ServiceFor(new IndexOverridingMirror(fixture.Mirror, failing))
                .RenumberRecord(fixture.TargetPlugin, fixture.Race.ToString()));

        Assert.True(
            orderBefore.AsSpan().SequenceEqual(File.ReadAllBytes(carrier)),
            "the parent's ordered child list did not return to its pre-action bytes");
        Assert.Equal(
            entriesBefore,
            Directory.GetFileSystemEntries(racesFolder).Select(Path.GetFileName).Order(StringComparer.Ordinal).ToList());
    }

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

    private static string ExtractNewFormKey(string message, string oldFormKey)
    {
        var after = message[(message.IndexOf($"{oldFormKey} to ", StringComparison.Ordinal) + oldFormKey.Length + 4)..];
        return after[..after.IndexOf(' ')];
    }

    // ---- the two oracles ----

    [Fact]
    public void TheDirectFilesystemOracleSeesAnEmptyDirectory_WhichGitStatusCallsClean()
    {
        using var fixture = new ContainerModFixture();
        var snapshotBefore = TreeSnapshot.Of(fixture.ModFolder);
        var statusBefore = fixture.GitStatus();

        Directory.CreateDirectory(Path.Combine(fixture.SourceRoot, "Stray Record Directory"));

        Assert.Equal(statusBefore, fixture.GitStatus());
        Assert.NotEqual(snapshotBefore, TreeSnapshot.Of(fixture.ModFolder));
    }

    // ---- doubles ----

    // One index write per rewritten referencing file plus one for the record itself, so the sweep's
    // position count comes off a real run.
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

    // Throws after that position's source file has already landed on disk.
    private sealed class FailingIndex(IRecordIndex inner, int failAt) : DelegatingRecordIndex(inner)
    {
        private int _seen;

        public bool Fired { get; private set; }

        // Runs in the failing call before it throws: the window in which a third party's write is concurrent.
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

    // Three mods, each its own repository: a cascade spanning one folder cannot show several working
    // trees restored.
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

        public IReadOnlyDictionary<string, IReadOnlyList<string>> Snapshots() =>
            AllPlugins.ToDictionary(p => p.Name, p => TreeSnapshot.Of(ModFolderOf(p)));

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
