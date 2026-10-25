using MEditService.Codec.Serialization;
using MEditService.Commands.Tests.TestSupport;
using MEditService.LoadOrder;
using MEditService.PluginAdapter;
using MEditService.TestSupport;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;
using Mutagen.Bethesda.Plugins.Records;

namespace MEditService.Commands.Tests.Edits;

public sealed class CompilePluginLinkTests : TestInstance
{
    private const string TargetName = "LinkTarget.esp";
    private const string HostNpcEditorId = "LinkHostNpc";
    private const string TargetKeywordEditorId = "LinkTargetKeyword";
    private const string Dangling = "ABCDEF:LinkTarget.esp";

    private readonly PluginAddress _host;
    private readonly PluginAddress _target;
    private readonly FormKey _npc;
    private readonly FormKey _targetKeyword;

    public CompilePluginLinkTests()
    {
        var target = new Fallout4Mod(ModKey.FromFileName(TargetName), Fallout4Release.Fallout4);
        _targetKeyword = target.Keywords.AddNew(TargetKeywordEditorId).FormKey;
        _target = Add(target, "LinkTargetMod");

        var host = new Fallout4Mod(ModKey.FromFileName("LinkHost.esp"), Fallout4Release.Fallout4);
        host.ModHeader.MasterReferences.Add(new MasterReference { Master = target.ModKey });
        var npc = host.Npcs.AddNew(HostNpcEditorId);
        npc.Keywords = [new FormLink<IKeywordGetter>(_targetKeyword)];
        _npc = npc.FormKey;
        _host = Add(host, "LinkHostMod");
    }

    private void PointTheNpcAt(FormKey keyword) =>
        SourceEdits.Rewrite<Npc>(
            RepositoryOf(_host).Require(), _host, new RecordIdentity(_npc.ToString(), "npc_", HostNpcEditorId),
            GameRelease.Fallout4,
            npc => npc.Keywords = [new FormLink<IKeywordGetter>(keyword)]);

    private async Task<CompileResult> CompileHost() =>
        (await CompileHandler.CompileAsync([_host])).Value();

    private IReadOnlyList<FormKey> KeywordsInTheBinary()
    {
        using var binary = this.Binary(_host);
        return [.. binary.Npcs.Single().Keywords.Require().Select(k => k.FormKey)];
    }

    [Fact]
    public async Task Compile_OfAPluginHoldingADanglingLink_WritesThePlugin_AndNamesTheRecordAndMember()
    {
        PointTheNpcAt(FormKey.Factory(Dangling));

        var answer = await CompileHost();

        Assert.Empty(answer.Refused);
        var diagnostics = Assert.Single(answer.Applied).Diagnostics;
        var diagnostic = Assert.Single(diagnostics, d => d.Message.Contains(Dangling, StringComparison.Ordinal));
        Assert.Equal(_npc.ToString(), diagnostic.FormKey);
        Assert.Equal($"Keywords: [0]: [{Dangling}] <Error: Could not be resolved>", diagnostic.Message);
        Assert.Equal([FormKey.Factory(Dangling)], KeywordsInTheBinary());
    }

    [Fact]
    public async Task Compile_WhenEveryLinkResolvesAgainstTheLoadOrdersFiles_ReportsNoLinkDiagnostic()
    {
        var answer = await CompileHost();

        Assert.Empty(answer.Refused);
        var diagnostics = Assert.Single(answer.Applied).Diagnostics;
        Assert.DoesNotContain(
            diagnostics, d => d.Message.Contains("Could not be resolved", StringComparison.Ordinal));
    }

    [Fact]
    public async Task Compile_ForALinkIntoACompiledPlugin_ReadsThatPluginsFile_NotItsWorkingTree()
    {
        SourceModTree.Remove(ModFolderOf(_target), _target, new RecordIdentity(_targetKeyword.ToString(), "kywd", TargetKeywordEditorId));

        var answer = await CompileHost();

        Assert.Empty(answer.Refused);
        var diagnostics = Assert.Single(answer.Applied).Diagnostics;
        Assert.DoesNotContain(
            diagnostics, d => d.Message.Contains("Could not be resolved", StringComparison.Ordinal));
    }

    [Fact]
    public async Task Compile_WhenALoadOrderFileCannotBeRead_NamesTheFile_AndReportsItsLinksAsUnchecked()
    {
        File.WriteAllText(Path.Combine(ModFolderOf(_target), TargetName), "not a plugin at all");

        var answer = await CompileHost();

        Assert.Empty(answer.Refused);
        var diagnostics = Assert.Single(answer.Applied).Diagnostics;
        var aboutTheFile = Assert.Single(
            diagnostics, d => d.Message.StartsWith(TargetName, StringComparison.Ordinal));
        Assert.Contains("could not be read", aboutTheFile.Message, StringComparison.Ordinal);
        var aboutTheLink = Assert.Single(
            diagnostics, d => d.Message.StartsWith("Keywords:", StringComparison.Ordinal));
        Assert.Equal(_npc.ToString(), aboutTheLink.FormKey);
        Assert.Contains($"{TargetName} could not be read", aboutTheLink.Message, StringComparison.Ordinal);
        Assert.DoesNotContain("Could not be resolved", aboutTheLink.Message, StringComparison.Ordinal);
    }

    [Fact]
    public async Task Compile_WhenTheLinkCheckItselfFails_StillSucceeds_AndSaysTheCheckDidNotRun()
    {
        var answer = (await CompileServices.Over(LoadOrder, new FaultyLinkAdapter())
            .CompileAsync([_host])).Value();

        Assert.Empty(answer.Refused);
        var diagnostics = Assert.Single(answer.Applied).Diagnostics;
        var diagnostic = Assert.Single(diagnostics);
        Assert.Contains("links could not be checked", diagnostic.Message, StringComparison.Ordinal);
        Assert.Contains(FaultyLinkAdapter.Fault, diagnostic.Message, StringComparison.Ordinal);
        Assert.Equal([_targetKeyword], KeywordsInTheBinary());
    }

    private sealed class FaultyLinkAdapter() : DelegatingPluginAdapter(TestAdapters.Mutagen())
    {
        internal const string Fault = "the link cache could not be built";

        public override LinkAnswers LinkTargets(
            LoadOrderSnapshot loadOrder,
            RegisteredPlugin compiled,
            IReadOnlyCollection<string> formKeys) =>
            throw new InvalidOperationException(Fault);
    }

    [Fact]
    public async Task Compile_ForALinkToARecordTheCompiledPluginItselfHolds_ReportsNothingAboutIt()
    {
        var ownKeyword = new Keyword(FormKey.Factory($"000801:{_host.Name}"), Fallout4Release.Fallout4)
        {
            EditorID = "HostOwnKeyword",
        };
        SourceEdits.Write(RepositoryOf(_host).Require(), _host, ownKeyword, "kywd", GameRelease.Fallout4);
        PointTheNpcAt(ownKeyword.FormKey);

        var answer = await CompileHost();

        Assert.Empty(answer.Refused);
        var diagnostics = Assert.Single(answer.Applied).Diagnostics;
        Assert.DoesNotContain(
            diagnostics, d => d.Message.Contains("Could not be resolved", StringComparison.Ordinal));
    }
}
