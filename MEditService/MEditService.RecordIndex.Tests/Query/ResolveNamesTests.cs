using MEditService.RecordIndex.Queries;
using MEditService.RecordIndex.Tests.TestSupport;
using MEditService.LoadOrder;
using MEditService.TestSupport;
using Mutagen.Bethesda;

namespace MEditService.RecordIndex.Tests.Query;

[Collection(TestPluginFixtureCollection.Name)]
public class ResolveNamesTests(TestPluginFixture fixture)
{
    private OpenedIndex LoadedIndex() => Indexes.Reconciled(fixture.DataFolder, fixture.Plugins);

    private static NameQuery Name(string name, string? origin = null) => new(name, origin);

    [Fact]
    public void APluginsFileName_ResolvesToThePluginWithItsOrigin()
    {
        using var index = LoadedIndex();

        var named = Assert.Single(index.Queries.ResolveNames([Name(TestPluginFixture.PluginName)]).Value());

        Assert.Equal(new PluginAddress(TestPluginFixture.PluginName, fixture.Plugins.Single().Origin), named.Plugin);
        Assert.Null(named.FormKey);
    }

    [Fact]
    public void AnEditorId_ResolvesToItsRecord_WhateverItsCase()
    {
        using var index = LoadedIndex();

        var named = Assert.Single(index.Queries.ResolveNames([Name("testnpc01")]).Value());

        Assert.Equal(fixture.Npc1FormKey.ToString(), named.FormKey);
        Assert.Equal("TestNPC01", named.EditorId);
        Assert.Null(named.Plugin);
    }

    [Fact]
    public void APluginsFileName_ResolvesWhateverItsCase()
    {
        using var index = LoadedIndex();

        var named = Assert.Single(index.Queries.ResolveNames([Name(TestPluginFixture.PluginName.ToUpperInvariant())]).Value());

        Assert.Equal(new PluginAddress(TestPluginFixture.PluginName, fixture.Plugins.Single().Origin), named.Plugin);
    }

    [Fact]
    public void AFormKey_ResolvesToItsRecord()
    {
        using var index = LoadedIndex();

        var named = Assert.Single(index.Queries.ResolveNames([Name(fixture.Npc1FormKey.ToString())]).Value());

        Assert.Equal(fixture.Npc1FormKey.ToString(), named.FormKey);
        Assert.Equal("TestNPC01", named.EditorId);
    }

    [Fact]
    public void SeveralNames_ResolveInTheOrderGiven()
    {
        using var index = LoadedIndex();

        var named = index.Queries.ResolveNames([Name("TestNPC02"), Name(TestPluginFixture.PluginName)]).Value();

        Assert.Equal(["TestNPC02", null], named.Select(n => n.EditorId));
        Assert.Equal([null, TestPluginFixture.PluginName], named.Select(n => n.Plugin?.Name));
    }

    [Fact]
    public void ANameNothingHas_IsRefusedNamingIt()
    {
        using var index = LoadedIndex();

        var refused = index.Queries.ResolveNames([Name("TestNPC01"), Name("NoSuchThing")]).Refused();

        Assert.Equal(IndexRefusal.NameRefused, refused.Refusal);
        Assert.Contains("NoSuchThing", refused.Message, StringComparison.Ordinal);
        Assert.DoesNotContain("TestNPC01", refused.Message, StringComparison.Ordinal);
    }

    [Fact]
    public void AFormKeyNoPluginHolds_IsRefused()
    {
        using var index = LoadedIndex();

        Assert.Equal(IndexRefusal.NameRefused, index.Queries.ResolveNames([Name("0FFFFF:TestPlugin.esp")]).Refused().Refusal);
    }

    [Fact]
    public void AnOrigin_NamesOnlyAPlugin()
    {
        using var index = LoadedIndex();

        Assert.Equal(IndexRefusal.NameRefused,
            index.Queries.ResolveNames([Name("TestNPC01", fixture.Plugins.Single().Origin)]).Refused().Refusal);
    }

    [Fact]
    public void AnOriginThePluginIsNotIn_IsRefused()
    {
        using var index = LoadedIndex();

        Assert.Equal(IndexRefusal.NameRefused,
            index.Queries.ResolveNames([Name(TestPluginFixture.PluginName, "NoSuchMod")]).Refused().Refusal);
    }

    [Fact]
    public void WithNoLoadOrder_IsRefusedAsSuch()
    {
        using var index = Indexes.Open(new LoadOrderHolder());

        Assert.Equal(IndexRefusal.NoLoadOrder, index.Queries.ResolveNames([Name("TestNPC01")]).Refused().Refusal);
    }

    [Fact]
    public void AFilenameTwoModsShare_IsRefusedListingEachWithItsOrigin()
    {
        using var shared = SharedFilename("names-shared");
        using var index = Indexes.Reconciled(shared);

        var refused = index.Queries.ResolveNames([Name("Shared.esp")]).Refused();

        Assert.Equal(IndexRefusal.NameRefused, refused.Refusal);
        Assert.Contains("ModA", refused.Message, StringComparison.Ordinal);
        Assert.Contains("ModB", refused.Message, StringComparison.Ordinal);
    }

    [Fact]
    public void AFilenameTwoModsShare_IsPickedByNamingItsOrigin()
    {
        using var shared = SharedFilename("names-picked");
        using var index = Indexes.Reconciled(shared);

        var named = Assert.Single(index.Queries.ResolveNames([Name("Shared.esp", "ModA")]).Value());

        Assert.Equal(new PluginAddress("Shared.esp", "ModA"), named.Plugin);
    }

    [Fact]
    public void AnEditorIdTwoRecordsShare_IsRefusedListingEachFormKey()
    {
        using var twins = new PluginFixtureBuilder("names-twins")
            .WithPlugin("Twins.esp", mod => { mod.Npcs.AddNew("Twin"); mod.Npcs.AddNew("Twin"); })
            .BuildScattered();
        using var index = Indexes.Reconciled(twins);

        var refused = index.Queries.ResolveNames([Name("Twin")]).Refused();

        Assert.Equal(IndexRefusal.NameRefused, refused.Refusal);
        Assert.Equal(2, refused.Message.Split(":Twins.esp").Length - 1);
    }

    [Fact]
    public void ARecordAnOverrideRenames_IsNamedByTheWinningCopysEditorId()
    {
        var holder = new LoadOrderHolder();
        using var shared = SharedFilename("names-renamed");
        using var index = Indexes.Open(holder).WithWinner(holder, shared.GameDirectory, shared.Plugins, "ModA");

        var named = Assert.Single(index.Queries.ResolveNames([Name("FromModA")]).Value());

        Assert.Equal("FromModA", named.EditorId);
        Assert.Equal(IndexRefusal.NameRefused, index.Queries.ResolveNames([Name("FromModB")]).Refused().Refusal);
        Assert.Equal("FromModA", Assert.Single(index.Queries.ResolveNames([Name(Assert.IsType<string>(named.FormKey))]).Value()).EditorId);
    }

    [Fact]
    public void ARecordAnOverrideRenames_FollowsTheWinnerWhenTheWinnerChanges()
    {
        var holder = new LoadOrderHolder();
        using var shared = SharedFilename("names-winner-changes");
        using var index = Indexes.Open(holder).WithWinner(holder, shared.GameDirectory, shared.Plugins, "ModB");

        var named = Assert.Single(index.Queries.ResolveNames([Name("FromModB")]).Value());

        Assert.Equal("FromModB", named.EditorId);
        Assert.Equal(IndexRefusal.NameRefused, index.Queries.ResolveNames([Name("FromModA")]).Refused().Refusal);
    }

    [Fact]
    public void ARecordOnlyInactivePluginsHold_IsNamedByTheFirstCopyInFilenameAndOriginOrder()
    {
        var holder = new LoadOrderHolder();
        using var shared = SharedFilename("names-inactive");
        using var index = Indexes.Open(holder);
        index.Reconcile(holder, shared.GameDirectory, [.. shared.Plugins.Select(p => p with { Enabled = false })], GameRelease.Fallout4);

        Assert.Equal("FromModA", Assert.Single(index.Queries.ResolveNames([Name("FromModA")]).Value()).EditorId);
        Assert.Equal(IndexRefusal.NameRefused, index.Queries.ResolveNames([Name("FromModB")]).Refused().Refusal);
    }

    [Fact]
    public void ARecordAnActivePluginHolds_IsNamedByItsCopyNotAnInactiveOnes()
    {
        var holder = new LoadOrderHolder();
        using var shared = SharedFilename("names-active-over-inactive");
        using var index = Indexes.Open(holder);
        index.Reconcile(
            holder, shared.GameDirectory,
            [.. shared.Plugins.Select(p => p with { Enabled = p.Origin == "ModB", Winning = p.Origin == "ModB" })], GameRelease.Fallout4);

        Assert.Equal("FromModB", Assert.Single(index.Queries.ResolveNames([Name("FromModB")]).Value()).EditorId);
        Assert.Equal(IndexRefusal.NameRefused, index.Queries.ResolveNames([Name("FromModA")]).Refused().Refusal);
    }

    private static ScatteredFixtureData SharedFilename(string prefix) =>
        new PluginFixtureBuilder(prefix)
            .WithPlugin("Shared.esp", mod => mod.Npcs.AddNew("FromModB"), origin: "ModB")
            .WithPlugin("Shared.esp", mod => mod.Npcs.AddNew("FromModA"), origin: "ModA")
            .BuildScattered();
}
