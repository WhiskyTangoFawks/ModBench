using MEditService.Codec.Serialization;
using MEditService.Commands.Tests.TestSupport;
using MEditService.LoadOrder;
using MEditService.SourceAdapter;
using MEditService.TestSupport;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;
using Mutagen.Bethesda.Plugins.Records;

namespace MEditService.Commands.Tests.Edits;

/// <summary>A real source mod folder and the load order value over it, and nothing else: compile
/// reads only those.</summary>
public sealed class CompileFixture : TestInstance, ICompiledPlugin
{
    public const string Origin = "CompileMod";
    public const string PluginName = "Compile.esp";
    public const string NpcEditorId = "FixtureNpc";
    public const string OtherNpcEditorId = "UntouchedNpc";
    public const string NpcRecordType = "npc_";

    private const GameRelease Release = GameRelease.Fallout4;

    public string ModFolder => FolderOf(Origin);
    public PluginAddress Plugin { get; }

    public FormKey Npc { get; }
    public FormKey OtherNpc { get; }

    public CompileFixture()
    {
        var mod = new Fallout4Mod(ModKey.FromFileName(PluginName), Fallout4Release.Fallout4);
        var race = mod.Races.AddNew("FixtureRace");
        var npc = mod.Npcs.AddNew(NpcEditorId);
        npc.Race.SetTo(race);
        var otherNpc = mod.Npcs.AddNew(OtherNpcEditorId);
        Plugin = Add(mod, Origin);
        (Npc, OtherNpc) = (npc.FormKey, otherNpc.FormKey);
    }

    private ISourceRepository Repository => RepositoryOf(Plugin).Require();

    public void Rewrite<T>(FormKey formKey, string recordType, string? editorId, Action<T> change)
        where T : class, IMajorRecord =>
        SourceEdits.Rewrite(Repository, Plugin, new RecordIdentity(formKey.ToString(), recordType, editorId), Release, change);

    public RecordIdentity NpcIdentity => new(Npc.ToString(), NpcRecordType, NpcEditorId);
}
