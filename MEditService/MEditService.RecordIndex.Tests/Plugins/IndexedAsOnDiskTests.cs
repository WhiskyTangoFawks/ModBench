using MEditService.LoadOrder;
using MEditService.PluginAdapter;
using MEditService.RecordIndex.Queries;
using MEditService.RecordIndex.Tests.TestSupport;
using MEditService.RepositoriesLib;
using MEditService.TestSupport;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Plugins;

namespace MEditService.RecordIndex.Tests.Plugins;

public sealed class IndexedAsOnDiskTests
{
    private static readonly PluginAddress Patch = new("Patch.esp", PluginOrigin.DataDirectory);

    [Fact]
    public void APluginRewrittenSinceItWasIndexed_IsNotYet_ThoughItsNameIsIndexed()
    {
        var holder = new LoadOrderHolder();
        using var data = new PluginFixtureBuilder("as-on-disk").WithPlugin("Patch.esp", m => m.Npcs.AddNew("Old")).Build();
        using var index = Indexes.Open(holder);
        index.Reconcile(holder, data.DataFolder, data.Plugins, GameRelease.Fallout4, data.InstanceRoot);
        Assert.Contains(Patch, index.Status.IndexedPlugins);
        Assert.Equal(PluginIndexing.AsOnDisk, index.Queries.GetPluginIndexedAsOnDisk(Patch).Value().State);

        PluginBinaries.Rewrite(Path.Combine(data.DataFolder, "Patch.esp"), m => m.Npcs.AddNew("New"));

        Assert.Contains(Patch, index.Status.IndexedPlugins);
        Assert.Equal(PluginIndexing.NotYet, index.Queries.GetPluginIndexedAsOnDisk(Patch).Value().State);
    }

    [Fact]
    public void APluginTheIndexHoldsNoRowsFor_IsNotYet()
    {
        var holder = new LoadOrderHolder();
        using var data = new PluginFixtureBuilder("as-on-disk-none").WithPlugin("Patch.esp").Build();
        using var index = Indexes.Open(holder);
        index.Reconcile(holder, data.DataFolder, data.Plugins, GameRelease.Fallout4, data.InstanceRoot);

        Assert.Equal(PluginIndexing.NotYet, index.Queries.GetPluginIndexedAsOnDisk(new PluginAddress("Other.esp", PluginOrigin.DataDirectory)).Value().State);
    }

    [Fact]
    public void APluginMEditFailedToRead_IsReadFailed_WithTheReasonItsStatusGives()
    {
        var holder = new LoadOrderHolder();
        using var data = new PluginFixtureBuilder("as-on-disk-failed").WithPlugin("Patch.esp").Build();
        using var index = Indexes.Open(holder, new FailsToRead());
        index.Reconcile(holder, data.DataFolder, data.Plugins, GameRelease.Fallout4, data.InstanceRoot);

        var answer = index.Queries.GetPluginIndexedAsOnDisk(Patch).Value();

        Assert.Equal(PluginIndexing.ReadFailed, answer.State);
        Assert.Equal(index.Status.Failures.Single(failure => failure.Name == "Patch.esp").Reason, answer.Reason);
    }

    [Fact]
    public void APluginRewrittenSinceMEditFailedToReadIt_IsNotYet_NotReadFailed()
    {
        var holder = new LoadOrderHolder();
        using var data = new PluginFixtureBuilder("as-on-disk-fixed").WithPlugin("Patch.esp", m => m.Npcs.AddNew("Broken")).Build();
        using var index = Indexes.Open(holder, new FailsToRead());
        index.Reconcile(holder, data.DataFolder, data.Plugins, GameRelease.Fallout4, data.InstanceRoot);
        Assert.Equal(PluginIndexing.ReadFailed, index.Queries.GetPluginIndexedAsOnDisk(Patch).Value().State);

        PluginBinaries.Rewrite(Path.Combine(data.DataFolder, "Patch.esp"), m => m.Npcs.AddNew("Fixed"));

        Assert.Equal(PluginIndexing.NotYet, index.Queries.GetPluginIndexedAsOnDisk(Patch).Value().State);
    }

    [Fact]
    public void ACompiledPluginABuildRewrote_IsAsOnDisk_OnceTheNextSnapshotValidatesItsTree()
    {
        using var fixture = new PluginFixtureBuilder("as-on-disk-built")
            .WithPlugin("Fixture.esp", m => m.Npcs.AddNew("FixtureNpc"), origin: "FixtureMod")
            .BuildScattered()
            .CompiledPlugin();
        var mod = fixture.Plugins.Single();
        using var index = Indexes.Reconciled(fixture);

        PluginBinaries.Touch(mod.Path);
        Assert.Equal(PluginIndexing.NotYet, index.Queries.GetPluginIndexedAsOnDisk(mod.Key).Value().State);

        index.NextSnapshotUntil(
            () => index.Queries.GetPluginIndexedAsOnDisk(mod.Key).Value().State == PluginIndexing.AsOnDisk, "the rewritten binary as on disk");
    }

    [Fact]
    public void ACompiledPluginABuildRewroteFromAnEditedTree_IsAsOnDisk_OnceTheNextSnapshotRefreshesTheEdit()
    {
        FormKey npc = default;
        using var fixture = new PluginFixtureBuilder("as-on-disk-built-edited")
            .WithPlugin("Fixture.esp", m => npc = m.Npcs.AddNew("FixtureNpc").FormKey, origin: "FixtureMod")
            .BuildScattered()
            .CompiledPlugin();
        var mod = fixture.Plugins.Single();
        using var index = Indexes.Reconciled(fixture);

        mod.HandEdit(index.DocumentOf(npc.ToString(), mod.Key), "\"FixtureNpc\"", "\"EditedBeforeTheBuild\"");
        PluginBinaries.Touch(mod.Path);
        index.NextSnapshotUntil(() => index.CopyIn(npc.ToString(), mod.Key)?.EditorId == "EditedBeforeTheBuild", "the edit refreshed");

        Assert.Equal(PluginIndexing.AsOnDisk, index.Queries.GetPluginIndexedAsOnDisk(mod.Key).Value().State);
    }

    [Fact]
    public void ACompiledPluginWithNoBinaryOnDisk_IsNotYet_AfterItsTreeValidates()
    {
        FormKey npc = default;
        using var fixture = new PluginFixtureBuilder("as-on-disk-no-binary")
            .WithPlugin("Fixture.esp", m => npc = m.Npcs.AddNew("FixtureNpc").FormKey, origin: "FixtureMod")
            .BuildScattered()
            .CompiledPlugin();
        var mod = fixture.Plugins.Single();
        using var index = Indexes.Reconciled(fixture);

        mod.HandEdit(index.DocumentOf(npc.ToString(), mod.Key), "\"FixtureNpc\"", "\"EditedMidBuild\"");
        File.Delete(mod.Path);
        index.NextSnapshotUntil(() => index.CopyIn(npc.ToString(), mod.Key)?.EditorId == "EditedMidBuild", "the edit refreshed");

        Assert.Equal(PluginIndexing.NotYet, index.Queries.GetPluginIndexedAsOnDisk(mod.Key).Value().State);
    }

    private sealed class FailsToRead() : DelegatingPluginAdapter(TestAdapters.Mutagen())
    {
        public override Answer<(PluginContent Content, PluginFailure? Unreachable), PluginFailure> ReadContent(
            ModPath modPath, LoadOrderSnapshot loadOrder, PluginStrings strings) => PluginFailures.Unparsed();
    }
}
