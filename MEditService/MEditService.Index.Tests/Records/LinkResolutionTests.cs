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
        "[1]: [FFFFFF:BASE.esm] <Error: Could not be resolved>; [2]: Found a race reference, expected: kywd";

    [Theory]
    [InlineData(0)]
    [InlineData(300)]
    public void ALinkResolvesByFilenameIgnoringCase_ADanglingOneDoesNot_AndAWrongTypeIsNamed_HoweverManyLinksTheRecordCarries(int moreKeywords)
    {
        var masterInAnotherCase = ModKey.FromFileName("BASE.ESM");
        FormKey npc = default;
        var linkedKeyword = "";
        using var fixture = new PluginFixtureBuilder($"link-resolution-{moreKeywords}")
            .WithPlugin("Base.esm", mod =>
            {
                mod.Keywords.AddNew("LinkedKeyword");
                mod.Races.AddNew("LinkedRace");
                for (var i = 0; i < moreKeywords; i++) mod.Keywords.AddNew($"MoreKeyword{i}");
            })
            .WithPlugin("Over.esp", (mod, built) =>
            {
                mod.ModHeader.MasterReferences.Add(new MasterReference { Master = masterInAnotherCase });
                var keywords = built[0].Keywords.Select(k => new FormKey(masterInAnotherCase, k.FormKey.ID)).ToList();
                linkedKeyword = keywords[0].ToString();
                var linker = mod.Npcs.AddNew("Linker");
                npc = linker.FormKey;
                linker.Keywords =
                [
                    new FormLink<IKeywordGetter>(keywords[0]),
                    new FormLink<IKeywordGetter>(new FormKey(masterInAnotherCase, 0xFFFFFF)),
                    new FormLink<IKeywordGetter>(new FormKey(masterInAnotherCase, built[0].Races.First().FormKey.ID)),
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
    }

    private static string? KeywordErrors(RecordDocument document) =>
        document.Fields.Single(f => f.Metadata.Name == "Keywords").CheckError;
}
