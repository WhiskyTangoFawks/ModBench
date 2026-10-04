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
    private static readonly PluginAddress OverKey = new("Over.esp", "Data");
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
        List<string> moreLinkedKeywords = [];
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
                moreLinkedKeywords = [.. keywords.Skip(1).Select(k => k.ToString())];
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
        var reads = index.RequireReads();
        var document = reads.DocumentOf(npc.ToString(), OverKey);
        Assert.Contains(linkedKeyword, document.BodyOf(), StringComparison.Ordinal);

        Assert.Equal(ExpectedKeywordErrors, KeywordErrors(document));
        var stack = reads.GetOverrideStack(npc.ToString());
        Assert.NotNull(stack);
        Assert.Equal(ExpectedKeywordErrors, KeywordErrors(Assert.Single(stack.Entries).Effective));
        Assert.Equal(ExpectedKeywordErrors, KeywordErrors(reads.GetDocuments(OverKey).Single(d => d.FormKey == npc.ToString())));

        var resolve = reads.LinkResolver(npc.ToString());
        Assert.Equal(new RecordLookupEntry("kywd", "WinningKeyword"), resolve(linkedKeyword));
        Assert.Null(resolve(dangling));
        Assert.Equal(new RecordLookupEntry("race", "LinkedRace"), resolve(linkedRace));
        Assert.All(moreLinkedKeywords, k => Assert.Equal("kywd", resolve(k)?.RecordType));
    }

    private const string ResolverPlugin = "Fixture.esp";

    [Theory]
    [InlineData(true)]
    [InlineData(false)]
    public void AResolverKeepsItsFirstAnswer_AfterTheIndexMovesOn_AndAFreshOneSeesTheNewRows(bool found)
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
        var asker = index.RequireReads().GetDocuments(plugin.KeyOf()).Single(d => d.RecordType == "npc_").FormKey;
        var resolve = index.RequireReads().LinkResolver(asker);
        var first = resolve(late.ToString())?.EditorId;
        Assert.Equal(found ? "Before" : null, first);

        PluginBinaries.Rewrite(plugin.Path, mod =>
        {
            mod.Npcs.AddNew("Asker");
            mod.Races.Add(new Race(late, Fallout4Release.Fallout4) { EditorID = "After" });
        });
        Assert.True(index.Revalidate());

        Assert.Equal(first, resolve(late.ToString())?.EditorId);
        Assert.Equal("After", index.RequireReads().LinkResolver(asker)(late.ToString())?.EditorId);
    }

    private static string? KeywordErrors(RecordDocument document) =>
        document.Fields.Single(f => f.Metadata.Name == "Keywords").CheckError;
}
