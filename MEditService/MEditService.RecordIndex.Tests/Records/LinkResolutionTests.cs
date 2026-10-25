using MEditService.Codec.Schema;
using MEditService.LoadOrder;
using MEditService.RecordIndex.Queries;
using MEditService.RecordIndex.Tests.TestSupport;
using MEditService.TestSupport;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;
using Mutagen.Bethesda.Plugins.Records;

namespace MEditService.RecordIndex.Tests.Records;

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

    private sealed class Resolving : IDisposable
    {
        private static readonly FormKey Late = FormKey.Factory($"000900:{ResolverPlugin}");

        private readonly ScatteredFixtureData _fixture;
        private readonly OpenedIndex _index;
        private readonly LoadOrderEntry _plugin;
        private readonly string _asker;

        public Resolving(string prefix, Action<Fallout4Mod> alsoHolds)
        {
            _fixture = new PluginFixtureBuilder(prefix)
                .WithPlugin(ResolverPlugin, mod =>
                {
                    mod.Npcs.AddNew("Asker");
                    alsoHolds(mod);
                }, origin: "FixtureMod")
                .BuildScattered();
            _index = Indexes.Reconciled(_fixture);
            _plugin = _fixture.Plugins.Single();
            _asker = _index.Queries.GetRecords(["npc_"], _plugin.Key, search: null, limit: 1, offset: 0).Value().Items.Single().FormKey;
        }

        public static void HoldsTheLateRaceAs(Fallout4Mod mod, string editorId) =>
            mod.Races.Add(new Race(Late, Fallout4Release.Fallout4) { EditorID = editorId });

        public FormKeyResolution LateLink => _index.ResolutionOf(_asker, _plugin.Key, Late.ToString());

        public void RewriteWithTheLateRaceAs(string editorId)
        {
            PluginBinaries.Rewrite(_plugin.Path, mod =>
            {
                mod.Npcs.AddNew("Asker");
                HoldsTheLateRaceAs(mod, editorId);
            });
            _index.NextSnapshot();
        }

        public void Dispose()
        {
            _index.Dispose();
            _fixture.Dispose();
        }
    }

    [Fact]
    public void ALinkThatResolved_ResolvesAgainstTheNewRow_OnceTheIndexMovesOn()
    {
        using var resolving = new Resolving("link-resolver-response-found", mod => Resolving.HoldsTheLateRaceAs(mod, "Before"));
        Assert.Equal("Before", resolving.LateLink.EditorId);

        resolving.RewriteWithTheLateRaceAs("After");

        Assert.Equal("After", resolving.LateLink.EditorId);
    }

    [Fact]
    public void ADanglingLink_Resolves_OnceItsRowArrives()
    {
        using var resolving = new Resolving("link-resolver-response-dangling", _ => { });
        Assert.Equal(FormKeyResolutionState.Unresolved, resolving.LateLink.State);

        resolving.RewriteWithTheLateRaceAs("After");

        Assert.Equal("After", resolving.LateLink.EditorId);
    }

    private static string? KeywordErrors(RecordDetail document) =>
        document.Fields.Single(f => f.Metadata.Name == "Keywords").CheckError;
}
