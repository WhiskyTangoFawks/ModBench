using MEditService.Codec.Schema;
using MEditService.Codec.Serialization;
using MEditService.TestSupport;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;
using Mutagen.Bethesda.Plugins.Records;

namespace MEditService.Codec.Tests.Schema;

public class FormReferencesOfRecordsTests
{
    private static readonly FormKey First = FormKey.Factory("000901:Target.esp");
    private static readonly FormKey Second = FormKey.Factory("000902:Target.esp");

    private const string ScriptsProperties = "VirtualMachineAdapter.Scripts[0].Properties[0]";
    private const string StructMember = ScriptsProperties + ".Members[0].Properties[0]";

    private static Fallout4Mod NewMod() => new(ModKey.FromFileName("Vmad.esp"), Fallout4Release.Fallout4);

    private static ScriptEntry ScriptWithObjectProperty(FormKey target)
    {
        var script = new ScriptEntry { Name = "Script", Flags = ScriptEntry.Flag.Local };
        var prop = new ScriptObjectProperty { Name = "TargetRef", Alias = -1 };
        prop.Object.SetTo(target);
        script.Properties.Add(prop);
        return script;
    }

    private static ScriptObjectProperty ObjectProperty(FormKey target)
    {
        var prop = new ScriptObjectProperty { Name = "Ref", Alias = -1 };
        prop.Object.SetTo(target);
        return prop;
    }

    private static Npc NpcWith(Fallout4Mod mod, ScriptProperty property)
    {
        var script = new ScriptEntry { Name = "Script", Flags = ScriptEntry.Flag.Local };
        script.Properties.Add(property);
        var npc = mod.Npcs.AddNew("Holder");
        npc.VirtualMachineAdapter = new VirtualMachineAdapter();
        npc.VirtualMachineAdapter.Scripts.Add(script);
        return npc;
    }

    private static ScriptStructProperty StructHolding(ScriptProperty member)
    {
        var wrapper = new ScriptEntry();
        wrapper.Properties.Add(member);
        var structProperty = new ScriptStructProperty { Name = "Config" };
        structProperty.Members.Add(wrapper);
        return structProperty;
    }

    private static readonly Dictionary<string, Func<Fallout4Mod, IMajorRecordGetter>> Records = new()
    {
        ["ArrayOfLinks"] = mod =>
        {
            var npc = mod.Npcs.AddNew("Holder");
            npc.Keywords = [new FormLink<IKeywordGetter>(First), new FormLink<IKeywordGetter>(Second)];
            return npc;
        },
        ["ArrayOfStructsWithALink"] = mod =>
        {
            var npc = mod.Npcs.AddNew("Holder");
            npc.Factions.Add(new RankPlacement { Faction = new FormLink<IFactionGetter>(First) });
            npc.Factions.Add(new RankPlacement { Faction = new FormLink<IFactionGetter>(Second) });
            return npc;
        },
        ["StructWithObjectMember"] = mod => NpcWith(mod, StructHolding(ObjectProperty(First))),
        ["StructNestedInsideAStruct"] = mod => NpcWith(mod, StructHolding(StructHolding(ObjectProperty(First)))),
        ["StructWithObjectListMember"] = mod =>
        {
            var objects = new ScriptObjectListProperty { Name = "Refs" };
            objects.Objects.Add(ObjectProperty(First));
            objects.Objects.Add(ObjectProperty(Second));
            return NpcWith(mod, StructHolding(objects));
        },
        ["StructListProperty"] = mod =>
        {
            var parts = new ScriptStructListProperty { Name = "Parts" };
            foreach (var target in new[] { First, Second })
            {
                var instance = new ScriptEntryStructs();
                instance.Members.Add(ObjectProperty(target));
                parts.Structs.Add(instance);
            }
            return NpcWith(mod, parts);
        },
        ["QuestAliasScript"] = mod =>
        {
            var alias = new QuestFragmentAlias();
            alias.Scripts.Add(ScriptWithObjectProperty(First));
            var quest = mod.Quests.AddNew("Holder");
            quest.VirtualMachineAdapter = new QuestAdapter();
            quest.VirtualMachineAdapter.Aliases.Add(alias);
            return quest;
        },
        ["QuestAliasOwnProperty"] = mod =>
        {
            var alias = new QuestFragmentAlias();
            alias.Property.Object.SetTo(First);
            alias.Property.Alias = -1;
            var quest = mod.Quests.AddNew("Holder");
            quest.VirtualMachineAdapter = new QuestAdapter();
            quest.VirtualMachineAdapter.Aliases.Add(alias);
            return quest;
        },
        ["QuestAliasScriptWithNestedStructAndStructList"] = mod =>
        {
            var script = new ScriptEntry { Name = "AliasScript", Flags = ScriptEntry.Flag.Local };
            script.Properties.Add(StructHolding(ObjectProperty(First)));
            var parts = new ScriptStructListProperty { Name = "Parts" };
            var instance = new ScriptEntryStructs();
            instance.Members.Add(ObjectProperty(Second));
            parts.Structs.Add(instance);
            script.Properties.Add(parts);
            var alias = new QuestFragmentAlias();
            alias.Scripts.Add(script);
            var quest = mod.Quests.AddNew("Holder");
            quest.VirtualMachineAdapter = new QuestAdapter();
            quest.VirtualMachineAdapter.Aliases.Add(alias);
            return quest;
        },
        ["QuestFragmentScript"] = mod =>
        {
            var quest = mod.Quests.AddNew("Holder");
            quest.VirtualMachineAdapter = new QuestAdapter { Script = ScriptWithObjectProperty(First) };
            return quest;
        },
        ["PackageFragmentScript"] = mod =>
        {
            var package = mod.Packages.AddNew("Holder");
            package.VirtualMachineAdapter = new PackageAdapter
            {
                ScriptFragments = new PackageScriptFragments { Script = ScriptWithObjectProperty(First) },
            };
            return package;
        },
        ["SceneFragmentScript"] = mod =>
        {
            var scene = new Scene(mod) { EditorID = "Holder" };
            scene.VirtualMachineAdapter = new SceneAdapter
            {
                ScriptFragments = new SceneScriptFragments { Script = ScriptWithObjectProperty(First) },
            };
            return scene;
        },
        ["DialogInfoFragmentScript"] = mod =>
        {
            var response = new DialogResponses(mod) { EditorID = "Holder" };
            response.VirtualMachineAdapter = new DialogResponsesAdapter
            {
                ScriptFragments = new ScriptFragments { Script = ScriptWithObjectProperty(First) },
            };
            return response;
        },
    };

    [Theory]
    [InlineData("ArrayOfLinks", "npc_", new[] { "Keywords[0]", "Keywords[1]" })]
    [InlineData("ArrayOfStructsWithALink", "npc_", new[] { "Factions[0].Faction", "Factions[1].Faction" })]
    [InlineData("StructWithObjectMember", "npc_", new[] { StructMember + ".Object" })]
    [InlineData("StructNestedInsideAStruct", "npc_", new string[0])]
    [InlineData("StructWithObjectListMember", "npc_", new[] { StructMember + ".Objects[0].Object", StructMember + ".Objects[1].Object" })]
    [InlineData("StructListProperty", "npc_", new[] { ScriptsProperties + ".Structs[0].Members[0].Object", ScriptsProperties + ".Structs[1].Members[0].Object" })]
    [InlineData("QuestAliasScript", "qust", new[] { "VirtualMachineAdapter.Aliases[0].Scripts[0].Properties[0].Object" })]
    [InlineData("QuestAliasOwnProperty", "qust", new[] { "VirtualMachineAdapter.Aliases[0].Property.Object" })]
    [InlineData("QuestAliasScriptWithNestedStructAndStructList", "qust", new[]
    {
        "VirtualMachineAdapter.Aliases[0].Scripts[0].Properties[0].Members[0].Properties[0].Object",
        "VirtualMachineAdapter.Aliases[0].Scripts[0].Properties[1].Structs[0].Members[0].Object",
    })]
    [InlineData("QuestFragmentScript", "qust", new[] { "VirtualMachineAdapter.Script.Properties[0].Object" })]
    [InlineData("PackageFragmentScript", "pack", new[] { "VirtualMachineAdapter.ScriptFragments.Script.Properties[0].Object" })]
    [InlineData("SceneFragmentScript", "scen", new[] { "VirtualMachineAdapter.ScriptFragments.Script.Properties[0].Object" })]
    [InlineData("DialogInfoFragmentScript", "info", new[] { "VirtualMachineAdapter.ScriptFragments.Script.Properties[0].Object" })]
    public void ARecordsLinks_NameEachTargetAtItsPath(string record, string recordType, string[] expectedPaths)
    {
        var text = RecordTextCodec.SerializeToText(Records[record](NewMod()), GameRelease.Fallout4);
        var columns = SharedSchemaReflector.Instance.GetSchemas(GameRelease.Fallout4)[recordType].RecordColumns;

        var references = FormReferences.Collect(text, columns);

        Assert.Equal(
            expectedPaths.Zip([First, Second], (path, target) => new FormReference(target.ToString(), path)),
            references);
    }

    [Fact]
    public void AQuestsOwnReferences_LeaveOutThoseUnderTheSceneItCarries()
    {
        var carried = new FormReference(First.ToString(), "Scenes[0].VirtualMachineAdapter.ScriptFragments.Script.Properties[0].Object");
        var own = new FormReference(Second.ToString(), "VirtualMachineAdapter.Script.Properties[0].Object");

        var references = new ContainerDocuments(GameRelease.Fallout4).OwnReferences("qust", [carried, own]);

        Assert.Equal([own], references);
    }
}
