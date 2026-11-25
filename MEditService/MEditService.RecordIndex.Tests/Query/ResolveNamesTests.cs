using MEditService.LoadOrder;
using MEditService.RecordIndex.Queries;
using MEditService.RecordIndex.Tests.TestSupport;
using MEditService.TestSupport;
using Mutagen.Bethesda;

namespace MEditService.RecordIndex.Tests.Query;

public sealed class ResolveNamesTests(SqlDoorFixture door) : IClassFixture<SqlDoorFixture>
{
    private IQueries Queries => door.Index.Queries;

    private static NameQuery Name(string name, string? origin = null) => new(name, origin);

    [Theory]
    [InlineData(TestPluginFixture.PluginName)]
    [InlineData("TESTPLUGIN.ESP")]
    public void APluginsFileName_ResolvesToThePluginWithItsOrigin_WhateverItsCase(string name)
    {
        var named = Assert.Single(Queries.ResolveNames([Name(name)]).Value());

        Assert.Equal((door.Plugin.Plugins.Single().Key, (string?)null), (named.Plugin, named.FormKey));
    }

    [Theory]
    [InlineData("testnpc01")]
    [InlineData("000800:TestPlugin.esp")]
    public void ARecordsNameOrFormKey_ResolvesToItsRecord(string name)
    {
        var named = Assert.Single(Queries.ResolveNames([Name(name)]).Value());

        Assert.Equal((door.Plugin.Npc1FormKey.ToString(), "TestNPC01", (PluginAddress?)null), (named.FormKey, named.EditorId, named.Plugin));
    }

    [Fact]
    public void SeveralNames_ResolveInTheOrderGiven()
    {
        var named = Queries.ResolveNames([Name("TestNPC02"), Name(TestPluginFixture.PluginName)]).Value();

        Assert.Equal(["TestNPC02", null], named.Select(n => n.EditorId));
        Assert.Equal([null, TestPluginFixture.PluginName], named.Select(n => n.Plugin?.Name));
    }

    [Fact]
    public void ANameNothingHas_IsRefusedNamingIt()
    {
        var refused = Queries.ResolveNames([Name("TestNPC01"), Name("NoSuchThing")]).Refused();

        Assert.Equal(IndexRefusal.NameRefused, refused.Refusal);
        Assert.Contains("NoSuchThing", refused.Message, StringComparison.Ordinal);
        Assert.DoesNotContain("TestNPC01", refused.Message, StringComparison.Ordinal);
    }

    [Theory]
    [InlineData("0FFFFF:TestPlugin.esp", null)]
    [InlineData("TestNPC01", PluginOrigin.DataDirectory)]
    [InlineData(TestPluginFixture.PluginName, "NoSuchMod")]
    public void AFormKeyOrAnOriginThatNamesNothing_IsRefused(string name, string? origin)
    {
        Assert.Equal(IndexRefusal.NameRefused, Queries.ResolveNames([Name(name, origin)]).Refused().Refusal);
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

    [Theory]
    [InlineData("ModA", "FromModA", "FromModB")]
    [InlineData("ModB", "FromModB", "FromModA")]
    public void ARecordAnOverrideRenames_IsNamedByTheWinningCopysEditorId(string winner, string winning, string losing)
    {
        var holder = new LoadOrderHolder();
        using var shared = SharedFilename("names-renamed");
        using var index = Indexes.Open(holder).WithWinner(holder, shared.DataFolder, shared.Plugins, winner);

        var named = Assert.Single(index.Queries.ResolveNames([Name(winning)]).Value());

        Assert.Equal(winning, named.EditorId);
        Assert.Equal(IndexRefusal.NameRefused, index.Queries.ResolveNames([Name(losing)]).Refused().Refusal);
        Assert.Equal(winning, Assert.Single(index.Queries.ResolveNames([Name(Assert.IsType<string>(named.FormKey))]).Value()).EditorId);
    }

    [Fact]
    public void ARecordOnlyInactivePluginsHold_IsNamedByTheFirstCopyInFilenameAndOriginOrder()
    {
        var holder = new LoadOrderHolder();
        using var shared = SharedFilename("names-inactive");
        using var index = Indexes.Open(holder);
        index.Reconcile(holder, shared.DataFolder, [.. shared.Plugins.Select(p => p with { Enabled = false })], GameRelease.Fallout4);

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
            holder, shared.DataFolder,
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
