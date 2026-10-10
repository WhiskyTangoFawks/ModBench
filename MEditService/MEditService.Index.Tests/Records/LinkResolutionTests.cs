using MEditService.Codec.Schema;
using MEditService.Index.Queries;
using MEditService.Index.Tests.TestSupport;
using MEditService.LoadOrder;
using MEditService.TestSupport;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;
using Mutagen.Bethesda.Plugins.Records;

namespace MEditService.Index.Tests.Records;

public sealed class LinkResolutionTests
{
    private static readonly PluginAddress OverKey = new("Over.esp", PluginOrigin.DataDirectory);
    private const string ExpectedKeywordErrors =
        "[1]: [FFFFFF:BASE.esm] <Error: Could not be resolved>; [2]: Found a RACE reference, expected: KYWD";

    [Theory]
    [InlineData(0)]
    [InlineData(300)]
    public void ALinkResolvesToItsWinnerByFilenameIgnoringCase_ADanglingOneDoesNot_AndAWrongTypeIsNamed_HoweverManyLinksTheRecordCarries(int moreKeywords)
    {
        var masterInAnotherCase = ModKey.FromFileName("BASE.ESM");
        FormKey npc = default;
        var linkedKeyword = "";
        var dangling = new FormKey(masterInAnotherCase, 0xFFFFFF).ToString();
        var linkedRace = "";
        using var fixture = new PluginFixtureBuilder($"link-resolution-{moreKeywords}")
            .WithPlugin("Base.esm", mod =>
            {
                mod.Keywords.AddNew("LinkedKeyword");
                mod.Races.AddNew("LinkedRace");
                for (var i = 0; i < moreKeywords; i++) mod.Keywords.AddNew($"MoreKeyword{i}");
            })
            .WithPlugin("Patch.esp", (mod, built) =>
            {
                mod.ModHeader.MasterReferences.Add(new MasterReference { Master = built[0].ModKey });
                mod.Keywords.GetOrAddAsOverride(built[0].Keywords.First()).EditorID = "WinningKeyword";
            })
            .WithPlugin("Over.esp", (mod, built) =>
            {
                mod.ModHeader.MasterReferences.Add(new MasterReference { Master = masterInAnotherCase });
                var keywords = built[0].Keywords.Select(k => new FormKey(masterInAnotherCase, k.FormKey.ID)).ToList();
                linkedKeyword = keywords[0].ToString();
                linkedRace = new FormKey(masterInAnotherCase, built[0].Races.First().FormKey.ID).ToString();
                var linker = mod.Npcs.AddNew("Linker");
                npc = linker.FormKey;
                linker.Keywords =
                [
                    new FormLink<IKeywordGetter>(keywords[0]),
                    new FormLink<IKeywordGetter>(FormKey.Factory(dangling)),
                    new FormLink<IKeywordGetter>(FormKey.Factory(linkedRace)),
                    .. keywords.Skip(1).Select(k => new FormLink<IKeywordGetter>(k)),
                ];
            })
            .Build();
        using var index = Indexes.Reconciled(fixture);
        var linker = npc.ToString();
        Assert.Contains(linkedKeyword, index.BodyOf(linker, OverKey), StringComparison.Ordinal);

        Assert.Equal(ExpectedKeywordErrors, KeywordErrors(index.DocumentOf(linker, OverKey)));
        Assert.Equal(ExpectedKeywordErrors, KeywordErrors(Assert.Single(index.StackOf(linker))));
        Assert.Equal(ExpectedKeywordErrors, KeywordErrors(index.Queries.GetRecord(linker).Value()
            ?? throw new InvalidOperationException("Expected the linker to have a winner.")));

        Assert.Equal(
            new FormKeyResolution(FormKeyResolutionState.ResolvedWrongType, "kywd", "WinningKeyword"),
            index.ResolutionOf(linker, OverKey, linkedKeyword));
        Assert.Equal(FormKeyResolutionState.Unresolved, index.ResolutionOf(linker, OverKey, dangling).State);
        Assert.Equal(
            new FormKeyResolution(FormKeyResolutionState.ResolvedValidType, "race", "LinkedRace"),
            index.ResolutionOf(linker, OverKey, linkedRace));
    }

    private const string ResolverPlugin = "Fixture.esp";

    [Theory]
    [InlineData(true)]
    [InlineData(false)]
    public void ACompareAfterTheIndexMovesOn_ResolvesALinkAgainstTheNewRows(bool found)
    {
        var late = FormKey.Factory($"000900:{ResolverPlugin}");
        using var fixture = new PluginFixtureBuilder($"link-resolver-response-{found}")
            .WithPlugin(ResolverPlugin, mod =>
            {
                mod.Npcs.AddNew("Asker");
                if (found) mod.Races.Add(new Race(late, Fallout4Release.Fallout4) { EditorID = "Before" });
            }, origin: "FixtureMod")
            .BuildScattered();
        using var index = Indexes.Reconciled(fixture);
        var plugin = fixture.Plugins.Single();
        var asker = index.Queries.GetRecords(["npc_"], plugin.KeyOf(), search: null, limit: 1, offset: 0).Value().Items.Single().FormKey;
        Assert.Equal(found ? "Before" : null, index.ResolutionOf(asker, plugin.KeyOf(), late.ToString()).EditorId);

        PluginBinaries.Rewrite(plugin.Path, mod =>
        {
            mod.Npcs.AddNew("Asker");
            mod.Races.Add(new Race(late, Fallout4Release.Fallout4) { EditorID = "After" });
        });
        index.NextSnapshot();

        Assert.Equal("After", index.ResolutionOf(asker, plugin.KeyOf(), late.ToString()).EditorId);
    }

    private static string? KeywordErrors(RecordDetail document) =>
        document.Fields.Single(f => f.Metadata.Name == "Keywords").CheckError;
}
