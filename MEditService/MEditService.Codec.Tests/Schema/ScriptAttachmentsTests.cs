using MEditService.Codec.Schema;
using MEditService.Codec.Serialization;
using MEditService.TestSupport;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Plugins;
using Mutagen.Bethesda.Plugins.Records;
using Fo4 = Mutagen.Bethesda.Fallout4;
using Tes5 = Mutagen.Bethesda.Skyrim;

namespace MEditService.Codec.Tests.Schema;

public class ScriptAttachmentsTests
{
    private static Fo4.Fallout4Mod NewMod() => new(ModKey.FromFileName("Vmad.esp"), Fo4.Fallout4Release.Fallout4);

    private static Fo4.ScriptEntry Script(string name)
    {
        var script = new Fo4.ScriptEntry { Name = name, Flags = Fo4.ScriptEntry.Flag.Local };
        script.Properties.Add(new Fo4.ScriptIntProperty { Name = "Count", Data = 1 });
        return script;
    }

    private static readonly Dictionary<string, Func<Fo4.Fallout4Mod, IMajorRecordGetter>> Records = new()
    {
        ["ObjectScripts"] = mod =>
        {
            var npc = mod.Npcs.AddNew("Holder");
            npc.VirtualMachineAdapter = new Fo4.VirtualMachineAdapter();
            npc.VirtualMachineAdapter.Scripts.Add(Script("First"));
            npc.VirtualMachineAdapter.Scripts.Add(Script("Ns:Second"));
            return npc;
        },
        ["QuestAliasAndFragmentScripts"] = mod =>
        {
            var alias = new Fo4.QuestFragmentAlias();
            alias.Scripts.Add(Script("First"));
            var quest = mod.Quests.AddNew("Holder");
            quest.VirtualMachineAdapter = new Fo4.QuestAdapter { Script = Script("Ns:Second") };
            quest.VirtualMachineAdapter.Aliases.Add(alias);
            return quest;
        },
    };

    [Theory]
    [InlineData("ObjectScripts", "npc_", new[] { "VirtualMachineAdapter.Scripts[0].Name", "VirtualMachineAdapter.Scripts[1].Name" })]
    [InlineData("QuestAliasAndFragmentScripts", "qust", new[] { "VirtualMachineAdapter.Script.Name", "VirtualMachineAdapter.Aliases[0].Scripts[0].Name" })]
    public void ARecordsScripts_AreEachNamedAtItsPath(string record, string recordType, string[] expectedPaths)
    {
        var text = RecordTextCodec.SerializeToText(Records[record](NewMod()), GameRelease.Fallout4);
        var columns = SharedSchemaReflector.Instance.GetSchemas(GameRelease.Fallout4)[recordType].RecordColumns;

        var attached = ScriptAttachments.Collect(text, columns);

        Assert.Equal(expectedPaths.Order(StringComparer.Ordinal), attached.Select(a => a.FieldPath).Order(StringComparer.Ordinal));
        Assert.Equal(["First", "Ns:Second"], attached.Select(a => a.Name).Order(StringComparer.Ordinal));
    }

    [Fact]
    public void ASkyrimRecordsScript_IsNamedAtItsPath()
    {
        var mod = new Tes5.SkyrimMod(ModKey.FromFileName("Vmad.esp"), Tes5.SkyrimRelease.SkyrimSE);
        var npc = mod.Npcs.AddNew("Holder");
        npc.VirtualMachineAdapter = new Tes5.VirtualMachineAdapter();
        npc.VirtualMachineAdapter.Scripts.Add(new Tes5.ScriptEntry { Name = "Attached" });
        var text = RecordTextCodec.SerializeToText(npc, GameRelease.SkyrimSE);

        var attached = ScriptAttachments.Collect(text, SharedSchemaReflector.Instance.GetSchemas(GameRelease.SkyrimSE)["npc_"].RecordColumns);

        Assert.Equal([new ScriptAttachment("Attached", "VirtualMachineAdapter.Scripts[0].Name")], attached);
    }

    private static FieldMetadata Member(FieldMetadata meta, string name) =>
        (meta.Fields ?? throw new InvalidOperationException($"Expected '{meta.Name}' to have fields.")).Single(f => f.Name == name);

    private static FieldMetadata Element(FieldMetadata meta) =>
        meta.ElementType ?? throw new InvalidOperationException($"Expected '{meta.Name}' to have an element type.");

    [Fact]
    public void TheSchema_MarksAScriptsNameAndNotItsPropertysName()
    {
        var adapter = SharedSchemaReflector.Instance.GetSchemas(GameRelease.Fallout4)["npc_"].RecordColumns
            .Single(c => c.Name == "VirtualMachineAdapter").Field;
        var script = Element(Member(adapter, "Scripts"));

        Assert.True(Member(script, "Name").IsScriptName);
        Assert.False(Member(Element(Member(script, "Properties")), "Name").IsScriptName);
    }
}
