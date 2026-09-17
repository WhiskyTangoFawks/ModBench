using MEditService.Commands.Edits;
using MEditService.LoadOrder;
using MEditService.PluginAdapter;
using MEditService.SourceRepo;
using MEditService.Tests.TestSupport;
using Microsoft.Extensions.Logging.Abstractions;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;
using Mutagen.Bethesda.Plugins.Records;

namespace MEditService.Tests.Edits;

/// <summary>Track and Compile of each plugin land only that plugin's own children in its own
/// compiled binary; the merged cross-plugin winner view belongs to the Index and Queries.</summary>
public sealed class InjectedChildTests : IDisposable
{
    public static TheoryData<string> Injections =>
        [TopicUnderQuest, BranchUnderQuest, SceneUnderQuest, ResponseUnderTopic];

    private const string TopicUnderQuest = "a topic under a quest";
    private const string BranchUnderQuest = "a dialog branch under a quest";
    private const string SceneUnderQuest = "a scene under a quest";
    private const string ResponseUnderTopic = "a response under a dialog topic";

    private const string BasePluginName = "InjectionBase.esm";
    private const string BaseOrigin = "InjectionBaseMod";
    private const string InjectorPluginName = "InjectionInjector.esp";
    private const string InjectorOrigin = "InjectionInjectorMod";

    private readonly string _instanceRoot = Directory.CreateTempSubdirectory("medit-injection-instance-").FullName;
    private readonly string _baseModFolder;
    private readonly string _injectorModFolder;
    private readonly string _gameDirectory;
    private readonly LoadOrderSnapshot _loadOrder;

    private readonly PluginCopyKey _base = new(BasePluginName, BaseOrigin);
    private readonly PluginCopyKey _injector = new(InjectorPluginName, InjectorOrigin);

    private readonly FormKey _quest;
    private readonly FormKey _baseTopic;
    private readonly FormKey _injectedTopic;
    private readonly FormKey _injectedBranch;
    private readonly FormKey _injectedScene;
    private readonly FormKey _injectedResponse;

    public InjectedChildTests()
    {
        _baseModFolder = Directory.CreateDirectory(Path.Combine(_instanceRoot, "mods", BaseOrigin)).FullName;
        _injectorModFolder = Directory.CreateDirectory(Path.Combine(_instanceRoot, "mods", InjectorOrigin)).FullName;
        _gameDirectory = Directory.CreateDirectory(Path.Combine(_instanceRoot, "game")).FullName;

        var basePath = Path.Combine(_baseModFolder, BasePluginName);
        var baseMod = new Fallout4Mod(ModKey.FromFileName(BasePluginName), Fallout4Release.Fallout4);
        var baseQuest = new Quest(baseMod) { EditorID = "BaseQuest" };
        var baseTopic = new DialogTopic(baseMod) { EditorID = "BaseTopic" };
        baseTopic.Responses.Add(new DialogResponses(baseMod) { EditorID = "BaseResponse" });
        baseQuest.DialogTopics.Add(baseTopic);
        baseQuest.DialogBranches.Add(new DialogBranch(baseMod) { EditorID = "BaseBranch" });
        baseQuest.Scenes.Add(new Scene(baseMod) { EditorID = "BaseScene" });
        baseMod.Quests.Add(baseQuest);
        baseMod.WriteToBinary(basePath);
        (_quest, _baseTopic) = (baseQuest.FormKey, baseTopic.FormKey);

        var injectorPath = Path.Combine(_injectorModFolder, InjectorPluginName);
        var injectorMod = new Fallout4Mod(ModKey.FromFileName(InjectorPluginName), Fallout4Release.Fallout4);
        // The override carries the base's own FormKey (ADR-0008: masters are lifecycle-derived).
        var questOverride = new Quest(_quest, Fallout4Release.Fallout4) { EditorID = "BaseQuest" };
        var topicOverride = new DialogTopic(_baseTopic, Fallout4Release.Fallout4) { EditorID = "BaseTopic" };
        var injectedResponse = new DialogResponses(injectorMod) { EditorID = "InjectedResponse" };
        var injectedTopic = new DialogTopic(injectorMod) { EditorID = "InjectedTopic" };
        var injectedBranch = new DialogBranch(injectorMod) { EditorID = "InjectedBranch" };
        var injectedScene = new Scene(injectorMod) { EditorID = "InjectedScene" };
        topicOverride.Responses.Add(injectedResponse);
        questOverride.DialogTopics.Add(topicOverride);
        questOverride.DialogTopics.Add(injectedTopic);
        questOverride.DialogBranches.Add(injectedBranch);
        questOverride.Scenes.Add(injectedScene);
        injectorMod.Quests.Add(questOverride);
        injectorMod.WriteToBinary(injectorPath);
        (_injectedTopic, _injectedBranch, _injectedScene, _injectedResponse) =
            (injectedTopic.FormKey, injectedBranch.FormKey, injectedScene.FormKey, injectedResponse.FormKey);

        _loadOrder = new LoadOrderSnapshot(_gameDirectory, _instanceRoot, GameRelease.Fallout4,
            SnapshotCopies.Of(
            [
                new LoadOrderEntry(BasePluginName, basePath, BaseOrigin, Slot: 0, Enabled: true, Winning: true),
                new LoadOrderEntry(InjectorPluginName, injectorPath, InjectorOrigin, Slot: 1, Enabled: true, Winning: true),
            ]));

        var track = new TrackService(NullLogger<TrackService>.Instance, MutagenPluginAdapter.Instance);
        foreach (var origin in new[] { BaseOrigin, InjectorOrigin })
            track.TrackAsync(_loadOrder, origin, SourcePreset.Edits).GetAwaiter().GetResult();
    }

    private (FormKey Container, FormKey Child) Case(string injection) => injection switch
    {
        TopicUnderQuest => (_quest, _injectedTopic),
        BranchUnderQuest => (_quest, _injectedBranch),
        SceneUnderQuest => (_quest, _injectedScene),
        ResponseUnderTopic => (_baseTopic, _injectedResponse),
        _ => throw new ArgumentOutOfRangeException(nameof(injection), injection, "No such injection case."),
    };

    [Theory]
    [MemberData(nameof(Injections))]
    public async Task AfterTrackAndCompileOfBothPlugins_TheInjectingPluginsBinaryHoldsTheChildUnderItsContainer(string injection)
    {
        var (container, child) = Case(injection);

        using var compiled = await CompileAndReimport(_injector, _injectorModFolder);

        Assert.Contains(child, ChildrenOf(compiled, container));
    }

    [Theory]
    [MemberData(nameof(Injections))]
    public async Task AfterTrackAndCompileOfBothPlugins_TheOwningPluginsBinaryKeepsItsOwnChildrenAndNotTheInjected(string injection)
    {
        var (container, child) = Case(injection);

        using var compiled = await CompileAndReimport(_base, _baseModFolder);

        var own = ChildrenOf(compiled, container);
        Assert.DoesNotContain(child, own);
        Assert.NotEmpty(own);
    }

    private async Task<IModDisposeGetter> CompileAndReimport(PluginCopyKey plugin, string modFolder)
    {
        var result = await CompileServices.Over(_loadOrder).CompileAsync(plugin, new CompileSource.WorkingTree());
        Assert.True(result.Succeeded, result.RefusalReason);

        return ModFactory.ImportGetter(
            new ModPath(ModKey.FromFileName(plugin.Name), Path.Combine(modFolder, plugin.Name)), GameRelease.Fallout4);
    }

    // Mutagen's own descent, so a case is a container FormKey and a child FormKey and nothing else.
    private static IEnumerable<FormKey> ChildrenOf(IModGetter mod, FormKey container) =>
        mod.EnumerateMajorRecords().Single(r => r.FormKey == container)
            .EnumerateMajorRecords().Select(r => r.FormKey);

    public void Dispose()
    {
        try { Directory.Delete(_instanceRoot, recursive: true); }
        catch (IOException) { /* scratch directory, best effort */ }
        catch (UnauthorizedAccessException) { /* ditto */ }
    }
}
