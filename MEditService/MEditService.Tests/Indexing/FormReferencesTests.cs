using DuckDB.NET.Data;
using MEditService.Core.Records;
using MEditService.Core.Schema;
using Microsoft.Extensions.Logging.Abstractions;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;
using Mutagen.Bethesda.Plugins.Records;

namespace MEditService.Tests.Indexing;

public class FormReferencesTests
{
    private static readonly SchemaReflector Reflector = SharedSchemaReflector.Instance;
    private static readonly TableDdlBuilder Ddl = new TableDdlBuilder(Reflector);

    private static DuckDbRecordIndex OpenRepo()
    {
        var repo = new DuckDbRecordIndex(Reflector, Ddl, NullLogger.Instance);
        repo.Initialize(GameRelease.Fallout4);
        return repo;
    }

    private static IModGetter LoadMod(string dataFolder, string pluginName)
    {
        var modPath = new ModPath(ModKey.FromFileName(pluginName), Path.Combine(dataFolder, pluginName));
        return Fallout4Mod.CreateFromBinaryOverlay(modPath, Fallout4Release.Fallout4);
    }

    [Fact]
    public void Index_ScalarFormKeyField_IsIndexedInFormReferences()
    {
        FormKey raceFormKey = default;
        FormKey npcFormKey = default;

        using var fixture = new PluginFixtureBuilder("form-refs-scalar")
            .WithPlugin("References.esp", mod =>
            {
                var race = mod.Races.AddNew("TestRace01");
                raceFormKey = race.FormKey;
                var npc = mod.Npcs.AddNew("TestNPC01");
                npcFormKey = npc.FormKey;
                npc.Race.SetTo(race.FormKey);
            })
            .Build();

        using var repo = OpenRepo();
        var mod = LoadMod(fixture.DataFolder, "References.esp");
        repo.Index(mod, Registration.Participating(0), new PluginKey(mod.ModKey.FileName.ToString(), "Data"));
        repo.UpdateWinners();

        using var cmd = repo.Connection.CreateCommand();
        cmd.CommandText = "SELECT target_form_key, field_path, record_type FROM form_references WHERE source_form_key = $1";
        cmd.Parameters.Add(new DuckDBParameter { Value = npcFormKey.ToString() });
        using var reader = cmd.ExecuteReader();

        var rows = new List<(string Target, string FieldPath, string RecordType)>();
        while (reader.Read())
            rows.Add((reader.GetString(0), reader.GetString(1), reader.GetString(2)));

        var raceRow = rows.FirstOrDefault(r => r.FieldPath == "race");
        Assert.NotEqual(default, raceRow);
        Assert.Equal(raceFormKey.ToString(), raceRow.Target);
        Assert.Equal("npc_", raceRow.RecordType);
    }

    [Fact]
    public void Index_NoFormLinkFieldsSet_FormReferencesIsEmpty()
    {
        using var fixture = new PluginFixtureBuilder("form-refs-empty")
            .WithPlugin("NoRefs.esp", mod => mod.Npcs.AddNew("BareNPC"))
            .Build();

        using var repo = OpenRepo();
        var mod = LoadMod(fixture.DataFolder, "NoRefs.esp");
        repo.Index(mod, Registration.Participating(0), new PluginKey(mod.ModKey.FileName.ToString(), "Data"));
        repo.UpdateWinners();

        using var cmd = repo.Connection.CreateCommand();
        cmd.CommandText = "SELECT COUNT(*) FROM form_references";
        var count = (long)cmd.ExecuteScalar()!;

        Assert.Equal(0, count);
    }

    [Fact]
    public void Index_ReIndexSamePlugin_ReplacesRatherThanDuplicates()
    {
        FormKey raceFormKey = default;

        using var fixture = new PluginFixtureBuilder("form-refs-reindex")
            .WithPlugin("Reindex.esp", mod =>
            {
                var race = mod.Races.AddNew("TestRace01");
                raceFormKey = race.FormKey;
                var npc = mod.Npcs.AddNew("TestNPC01");
                npc.Race.SetTo(race.FormKey);
            })
            .Build();

        using var repo = OpenRepo();
        var mod = LoadMod(fixture.DataFolder, "Reindex.esp");
        repo.Index(mod, Registration.Participating(0), new PluginKey(mod.ModKey.FileName.ToString(), "Data"));
        repo.Index(mod, Registration.Participating(0), new PluginKey(mod.ModKey.FileName.ToString(), "Data"));  // re-index same plugin
        repo.UpdateWinners();

        using var raceCmd = repo.Connection.CreateCommand();
        raceCmd.CommandText = "SELECT COUNT(*) FROM form_references WHERE field_path = 'race' AND source_plugin = 'Reindex.esp'";
        var raceCount = (long)raceCmd.ExecuteScalar()!;
        Assert.Equal(1, raceCount);
    }

    [Fact]
    public void Index_ArrayFormKeyField_IsIndexedInFormReferences()
    {
        FormKey kwFormKey = default;
        FormKey npcFormKey = default;

        using var fixture = new PluginFixtureBuilder("form-refs-array-fk")
            .WithPlugin("ArrayFk.esp", mod =>
            {
                var kw = mod.Keywords.AddNew();
                kw.EditorID = "TestKw01";
                kwFormKey = kw.FormKey;

                var npc = mod.Npcs.AddNew("TestNPC_ArrayFk");
                npcFormKey = npc.FormKey;
                npc.Keywords = [new FormLink<IKeywordGetter>(kwFormKey)];
            })
            .Build();

        using var repo = OpenRepo();
        var mod = LoadMod(fixture.DataFolder, "ArrayFk.esp");
        repo.Index(mod, Registration.Participating(0), new PluginKey(mod.ModKey.FileName.ToString(), "Data"));
        repo.UpdateWinners();

        using var cmd = repo.Connection.CreateCommand();
        cmd.CommandText = "SELECT target_form_key, field_path FROM form_references WHERE source_form_key = $1";
        cmd.Parameters.Add(new DuckDBParameter { Value = npcFormKey.ToString() });
        using var reader = cmd.ExecuteReader();

        var rows = new List<(string Target, string FieldPath)>();
        while (reader.Read())
            rows.Add((reader.GetString(0), reader.GetString(1)));

        var kwRow = rows.FirstOrDefault(r => r.FieldPath == "keywords[0]");
        Assert.NotEqual(default, kwRow);
        Assert.Equal(kwFormKey.ToString(), kwRow.Target);
    }

    [Fact]
    public void Index_ArrayOfStructWithFormKeySubField_IsIndexedInFormReferences()
    {
        FormKey factionFormKey = default;
        FormKey npcFormKey = default;

        using var fixture = new PluginFixtureBuilder("form-refs-array-struct")
            .WithPlugin("ArrayStruct.esp", mod =>
            {
                var faction = mod.Factions.AddNew("TestFaction01");
                factionFormKey = faction.FormKey;

                var npc = mod.Npcs.AddNew("TestNPC_ArrayStruct");
                npcFormKey = npc.FormKey;
                npc.Factions.Add(new RankPlacement { Faction = new FormLink<IFactionGetter>(factionFormKey) });
            })
            .Build();

        using var repo = OpenRepo();
        var mod = LoadMod(fixture.DataFolder, "ArrayStruct.esp");
        repo.Index(mod, Registration.Participating(0), new PluginKey(mod.ModKey.FileName.ToString(), "Data"));
        repo.UpdateWinners();

        using var cmd = repo.Connection.CreateCommand();
        cmd.CommandText = "SELECT target_form_key, field_path FROM form_references WHERE source_form_key = $1";
        cmd.Parameters.Add(new DuckDBParameter { Value = npcFormKey.ToString() });
        using var reader = cmd.ExecuteReader();

        var rows = new List<(string Target, string FieldPath)>();
        while (reader.Read())
            rows.Add((reader.GetString(0), reader.GetString(1)));

        var factionRow = rows.FirstOrDefault(r => r.FieldPath == "factions[0].faction");
        Assert.NotEqual(default, factionRow);
        Assert.Equal(factionFormKey.ToString(), factionRow.Target);
    }

    [Fact]
    public void Index_VmadStructWithObjectMember_IsIndexedInFormReferences()
    {
        FormKey targetFormKey = default;
        FormKey npcFormKey = default;

        using var fixture = new PluginFixtureBuilder("form-refs-vmad-struct")
            .WithPlugin("VmadStructRef.esp", mod =>
            {
                var target = mod.Npcs.AddNew("RefTarget");
                targetFormKey = target.FormKey;

                var npc = mod.Npcs.AddNew("VmadStructNpc");
                npcFormKey = npc.FormKey;

                var vmad = new VirtualMachineAdapter();
                var script = new ScriptEntry { Name = "DefaultScript", Flags = ScriptEntry.Flag.Local };
                var structProp = new ScriptStructProperty { Name = "Config" };
                var wrapper = new ScriptEntry();
                var objMember = new ScriptObjectProperty { Name = "TargetRef", Alias = -1 };
                objMember.Object.SetTo(targetFormKey);
                wrapper.Properties.Add(objMember);
                structProp.Members.Add(wrapper);
                script.Properties.Add(structProp);
                vmad.Scripts.Add(script);
                npc.VirtualMachineAdapter = vmad;
            })
            .Build();

        using var repo = OpenRepo();
        var mod = LoadMod(fixture.DataFolder, "VmadStructRef.esp");
        repo.Index(mod, Registration.Participating(0), new PluginKey(mod.ModKey.FileName.ToString(), "Data"));
        repo.UpdateWinners();

        using var cmd = repo.Connection.CreateCommand();
        cmd.CommandText = "SELECT target_form_key, field_path, record_type FROM form_references WHERE source_form_key = $1";
        cmd.Parameters.Add(new DuckDBParameter { Value = npcFormKey.ToString() });
        using var reader = cmd.ExecuteReader();

        var rows = new List<(string Target, string FieldPath, string RecordType)>();
        while (reader.Read())
            rows.Add((reader.GetString(0), reader.GetString(1), reader.GetString(2)));

        var row = rows.FirstOrDefault(r => r.FieldPath == @"VMAD\DefaultScript\Config\TargetRef");
        Assert.NotEqual(default, row);
        Assert.Equal(targetFormKey.ToString(), row.Target);
        Assert.Equal("npc_", row.RecordType);  // ResolveRecordType must tag the source record's own table
    }

    [Fact]
    public void Index_VmadNestedStructWithObjectMember_IsIndexedInFormReferences()
    {
        FormKey targetFormKey = default;
        FormKey npcFormKey = default;

        using var fixture = new PluginFixtureBuilder("form-refs-vmad-nested-struct")
            .WithPlugin("VmadNestedStructRef.esp", mod =>
            {
                var target = mod.Npcs.AddNew("RefTarget");
                targetFormKey = target.FormKey;

                var npc = mod.Npcs.AddNew("VmadNestedStructNpc");
                npcFormKey = npc.FormKey;

                var vmad = new VirtualMachineAdapter();
                var script = new ScriptEntry { Name = "DefaultScript", Flags = ScriptEntry.Flag.Local };

                // Config = Struct { Inner = Struct { TargetRef = Object } }
                var outer = new ScriptStructProperty { Name = "Config" };
                var outerWrapper = new ScriptEntry();
                var inner = new ScriptStructProperty { Name = "Inner" };
                var innerWrapper = new ScriptEntry();
                var objMember = new ScriptObjectProperty { Name = "TargetRef", Alias = -1 };
                objMember.Object.SetTo(targetFormKey);
                innerWrapper.Properties.Add(objMember);
                inner.Members.Add(innerWrapper);
                outerWrapper.Properties.Add(inner);
                outer.Members.Add(outerWrapper);
                script.Properties.Add(outer);
                vmad.Scripts.Add(script);
                npc.VirtualMachineAdapter = vmad;
            })
            .Build();

        using var repo = OpenRepo();
        var mod = LoadMod(fixture.DataFolder, "VmadNestedStructRef.esp");
        repo.Index(mod, Registration.Participating(0), new PluginKey(mod.ModKey.FileName.ToString(), "Data"));
        repo.UpdateWinners();

        using var cmd = repo.Connection.CreateCommand();
        cmd.CommandText = "SELECT target_form_key, field_path FROM form_references WHERE source_form_key = $1";
        cmd.Parameters.Add(new DuckDBParameter { Value = npcFormKey.ToString() });
        using var reader = cmd.ExecuteReader();

        var rows = new List<(string Target, string FieldPath)>();
        while (reader.Read())
            rows.Add((reader.GetString(0), reader.GetString(1)));

        var row = rows.FirstOrDefault(r => r.FieldPath == @"VMAD\DefaultScript\Config\Inner\TargetRef");
        Assert.NotEqual(default, row);
        Assert.Equal(targetFormKey.ToString(), row.Target);
    }

    [Fact]
    public void Index_VmadStructWithObjectListMember_IsIndexedInFormReferences()
    {
        FormKey target0Fk = default, target1Fk = default;
        FormKey npcFormKey = default;

        using var fixture = new PluginFixtureBuilder("form-refs-vmad-struct-objlist")
            .WithPlugin("VmadStructObjList.esp", mod =>
            {
                var t0 = mod.Npcs.AddNew("ObjListTarget0"); target0Fk = t0.FormKey;
                var t1 = mod.Npcs.AddNew("ObjListTarget1"); target1Fk = t1.FormKey;

                var npc = mod.Npcs.AddNew("VmadObjListNpc");
                npcFormKey = npc.FormKey;

                var vmad = new VirtualMachineAdapter();
                var script = new ScriptEntry { Name = "DefaultScript", Flags = ScriptEntry.Flag.Local };
                var structProp = new ScriptStructProperty { Name = "Config" };
                var wrapper = new ScriptEntry();

                var objList = new ScriptObjectListProperty { Name = "Refs" };
                var item0 = new ScriptObjectProperty { Alias = -1 }; item0.Object.SetTo(target0Fk);
                var item1 = new ScriptObjectProperty { Alias = -1 }; item1.Object.SetTo(target1Fk);
                objList.Objects.Add(item0);
                objList.Objects.Add(item1);
                wrapper.Properties.Add(objList);
                structProp.Members.Add(wrapper);
                script.Properties.Add(structProp);
                vmad.Scripts.Add(script);
                npc.VirtualMachineAdapter = vmad;
            })
            .Build();

        using var repo = OpenRepo();
        var mod = LoadMod(fixture.DataFolder, "VmadStructObjList.esp");
        repo.Index(mod, Registration.Participating(0), new PluginKey(mod.ModKey.FileName.ToString(), "Data"));
        repo.UpdateWinners();

        using var cmd = repo.Connection.CreateCommand();
        cmd.CommandText = "SELECT target_form_key, field_path FROM form_references WHERE source_form_key = $1";
        cmd.Parameters.Add(new DuckDBParameter { Value = npcFormKey.ToString() });
        using var reader = cmd.ExecuteReader();

        var rows = new List<(string Target, string FieldPath)>();
        while (reader.Read())
            rows.Add((reader.GetString(0), reader.GetString(1)));

        Assert.Contains(rows, r => r.FieldPath == @"VMAD\DefaultScript\Config\Refs[0]" && r.Target == target0Fk.ToString());
        Assert.Contains(rows, r => r.FieldPath == @"VMAD\DefaultScript\Config\Refs[1]" && r.Target == target1Fk.ToString());
    }

    [Fact]
    public void Index_VmadStructWithStructListMember_IsIndexedInFormReferences()
    {
        FormKey target0Fk = default, target1Fk = default;
        FormKey npcFormKey = default;

        using var fixture = new PluginFixtureBuilder("form-refs-vmad-struct-structlist")
            .WithPlugin("VmadStructStructList.esp", mod =>
            {
                var t0 = mod.Npcs.AddNew("StructListTarget0"); target0Fk = t0.FormKey;
                var t1 = mod.Npcs.AddNew("StructListTarget1"); target1Fk = t1.FormKey;

                var npc = mod.Npcs.AddNew("VmadStructListNpc");
                npcFormKey = npc.FormKey;

                var vmad = new VirtualMachineAdapter();
                var script = new ScriptEntry { Name = "DefaultScript", Flags = ScriptEntry.Flag.Local };

                // Config = Struct { Parts = ArrayOfStruct [ {PartRef=Object}, {PartRef=Object} ] }
                var outer = new ScriptStructProperty { Name = "Config" };
                var outerWrapper = new ScriptEntry();
                var parts = new ScriptStructListProperty { Name = "Parts" };

                var inst0 = new ScriptEntryStructs();
                var ref0 = new ScriptObjectProperty { Name = "PartRef", Alias = -1 };
                ref0.Object.SetTo(target0Fk);
                inst0.Members.Add(ref0);
                parts.Structs.Add(inst0);

                var inst1 = new ScriptEntryStructs();
                var ref1 = new ScriptObjectProperty { Name = "PartRef", Alias = -1 };
                ref1.Object.SetTo(target1Fk);
                inst1.Members.Add(ref1);
                parts.Structs.Add(inst1);

                outerWrapper.Properties.Add(parts);
                outer.Members.Add(outerWrapper);
                script.Properties.Add(outer);
                vmad.Scripts.Add(script);
                npc.VirtualMachineAdapter = vmad;
            })
            .Build();

        using var repo = OpenRepo();
        var mod = LoadMod(fixture.DataFolder, "VmadStructStructList.esp");
        repo.Index(mod, Registration.Participating(0), new PluginKey(mod.ModKey.FileName.ToString(), "Data"));
        repo.UpdateWinners();

        using var cmd = repo.Connection.CreateCommand();
        cmd.CommandText = "SELECT target_form_key, field_path FROM form_references WHERE source_form_key = $1";
        cmd.Parameters.Add(new DuckDBParameter { Value = npcFormKey.ToString() });
        using var reader = cmd.ExecuteReader();

        var rows = new List<(string Target, string FieldPath)>();
        while (reader.Read())
            rows.Add((reader.GetString(0), reader.GetString(1)));

        Assert.Contains(rows, r => r.FieldPath == @"VMAD\DefaultScript\Config\Parts[0]\PartRef" && r.Target == target0Fk.ToString());
        Assert.Contains(rows, r => r.FieldPath == @"VMAD\DefaultScript\Config\Parts[1]\PartRef" && r.Target == target1Fk.ToString());
    }

    // ── #671: scripts reachable only through an adapter sub-structure ───────────────────────────
    //
    // Each test below indexes a plugin whose *only* mention of `targetFormKey` is the adapter route
    // named in the test, then asserts the full set of form_references rows aimed at that target —
    // not just "contains one". That total-set assertion is what makes these non-vacuous: if the
    // reflected schema walk or the condition walk could also see the same FormKey, the row count
    // would exceed one and the assertion would fail. Before the adapter walk existed every one of
    // these saw zero rows, which is the same proof from the other side.

    private static List<(string Source, string Target, string FieldPath, string RecordType)> ReferencesTo(
        DuckDbRecordIndex repo, FormKey target)
    {
        using var cmd = repo.Connection.CreateCommand();
        cmd.CommandText =
            "SELECT source_form_key, target_form_key, field_path, record_type FROM form_references WHERE target_form_key = $1";
        cmd.Parameters.Add(new DuckDBParameter { Value = target.ToString() });
        using var reader = cmd.ExecuteReader();
        var rows = new List<(string, string, string, string)>();
        while (reader.Read())
            rows.Add((reader.GetString(0), reader.GetString(1), reader.GetString(2), reader.GetString(3)));
        return rows;
    }

    private static DuckDbRecordIndex IndexOnly(PluginFixtureData fixture, string pluginName)
    {
        var repo = OpenRepo();
        var mod = LoadMod(fixture.DataFolder, pluginName);
        repo.Index(mod, Registration.Participating(0), new PluginKey(mod.ModKey.FileName.ToString(), "Data"));
        repo.UpdateWinners();
        return repo;
    }

    private static ScriptEntry ScriptWithObjectProperty(string scriptName, string propName, FormKey target)
    {
        var script = new ScriptEntry { Name = scriptName, Flags = ScriptEntry.Flag.Local };
        var prop = new ScriptObjectProperty { Name = propName, Alias = -1 };
        prop.Object.SetTo(target);
        script.Properties.Add(prop);
        return script;
    }

    [Fact]
    public void Index_QuestAliasScriptObjectProperty_IsIndexedInFormReferences()
    {
        FormKey targetFormKey = default;
        FormKey questFormKey = default;

        using var fixture = new PluginFixtureBuilder("form-refs-quest-alias-script")
            .WithPlugin("QuestAliasScript.esp", mod =>
            {
                targetFormKey = mod.Npcs.AddNew("AliasScriptTarget").FormKey;
                var quest = mod.Quests.AddNew("AliasScriptQuest");
                questFormKey = quest.FormKey;

                var adapter = new QuestAdapter();
                var alias = new QuestFragmentAlias();
                alias.Scripts.Add(ScriptWithObjectProperty("AliasScript", "TargetRef", targetFormKey));
                adapter.Aliases.Add(alias);
                quest.VirtualMachineAdapter = adapter;
            })
            .Build();

        using var repo = IndexOnly(fixture, "QuestAliasScript.esp");

        var row = Assert.Single(ReferencesTo(repo, targetFormKey));
        Assert.Equal(questFormKey.ToString(), row.Source);
        Assert.Equal(@"VMAD\Aliases[0]\AliasScript\TargetRef", row.FieldPath);
        Assert.Equal("qust", row.RecordType);
    }

    [Fact]
    public void Index_QuestAliasOwnScriptObjectProperty_IsIndexedInFormReferences()
    {
        FormKey targetFormKey = default;
        FormKey questFormKey = default;

        using var fixture = new PluginFixtureBuilder("form-refs-quest-alias-property")
            .WithPlugin("QuestAliasProperty.esp", mod =>
            {
                targetFormKey = mod.Npcs.AddNew("AliasPropertyTarget").FormKey;
                var quest = mod.Quests.AddNew("AliasPropertyQuest");
                questFormKey = quest.FormKey;

                var adapter = new QuestAdapter();
                var alias = new QuestFragmentAlias();
                alias.Property.Object.SetTo(targetFormKey);
                alias.Property.Alias = -1;
                adapter.Aliases.Add(alias);
                quest.VirtualMachineAdapter = adapter;
            })
            .Build();

        using var repo = IndexOnly(fixture, "QuestAliasProperty.esp");

        var row = Assert.Single(ReferencesTo(repo, targetFormKey));
        Assert.Equal(questFormKey.ToString(), row.Source);
        Assert.Equal(@"VMAD\Aliases[0]\Property", row.FieldPath);
        Assert.Equal("qust", row.RecordType);
    }

    [Fact]
    public void Index_QuestFragmentScriptObjectProperty_IsIndexedInFormReferences()
    {
        FormKey targetFormKey = default;
        FormKey questFormKey = default;

        using var fixture = new PluginFixtureBuilder("form-refs-quest-fragment-script")
            .WithPlugin("QuestFragmentScript.esp", mod =>
            {
                targetFormKey = mod.Npcs.AddNew("QuestFragmentTarget").FormKey;
                var quest = mod.Quests.AddNew("QuestFragmentQuest");
                questFormKey = quest.FormKey;

                quest.VirtualMachineAdapter = new QuestAdapter
                {
                    Script = ScriptWithObjectProperty("QuestFragments", "TargetRef", targetFormKey),
                };
            })
            .Build();

        using var repo = IndexOnly(fixture, "QuestFragmentScript.esp");

        var row = Assert.Single(ReferencesTo(repo, targetFormKey));
        Assert.Equal(questFormKey.ToString(), row.Source);
        Assert.Equal(@"VMAD\Script\QuestFragments\TargetRef", row.FieldPath);
        Assert.Equal("qust", row.RecordType);
    }

    [Fact]
    public void Index_PackageFragmentScriptObjectProperty_IsIndexedInFormReferences()
    {
        FormKey targetFormKey = default;
        FormKey packageFormKey = default;

        using var fixture = new PluginFixtureBuilder("form-refs-package-fragment-script")
            .WithPlugin("PackageFragmentScript.esp", mod =>
            {
                targetFormKey = mod.Npcs.AddNew("PackageFragmentTarget").FormKey;
                var package = mod.Packages.AddNew("FragmentPackage");
                packageFormKey = package.FormKey;

                package.VirtualMachineAdapter = new PackageAdapter
                {
                    ScriptFragments = new PackageScriptFragments
                    {
                        Script = ScriptWithObjectProperty("PackageScript", "TargetRef", targetFormKey),
                    },
                };
            })
            .Build();

        using var repo = IndexOnly(fixture, "PackageFragmentScript.esp");

        var row = Assert.Single(ReferencesTo(repo, targetFormKey));
        Assert.Equal(packageFormKey.ToString(), row.Source);
        Assert.Equal(@"VMAD\ScriptFragments\PackageScript\TargetRef", row.FieldPath);
        Assert.Equal("pack", row.RecordType);
    }

    [Fact]
    public void Index_SceneFragmentScriptObjectProperty_IsIndexedInFormReferences()
    {
        FormKey targetFormKey = default;
        FormKey sceneFormKey = default;

        using var fixture = new PluginFixtureBuilder("form-refs-scene-fragment-script")
            .WithPlugin("SceneFragmentScript.esp", mod =>
            {
                targetFormKey = mod.Npcs.AddNew("SceneFragmentTarget").FormKey;
                var quest = mod.Quests.AddNew("SceneOwnerQuest");
                var scene = new Scene(mod) { EditorID = "FragmentScene" };
                sceneFormKey = scene.FormKey;
                scene.VirtualMachineAdapter = new SceneAdapter
                {
                    ScriptFragments = new SceneScriptFragments
                    {
                        Script = ScriptWithObjectProperty("SceneScript", "TargetRef", targetFormKey),
                    },
                };
                quest.Scenes.Add(scene);
            })
            .Build();

        using var repo = IndexOnly(fixture, "SceneFragmentScript.esp");

        var row = Assert.Single(ReferencesTo(repo, targetFormKey));
        Assert.Equal(sceneFormKey.ToString(), row.Source);
        Assert.Equal(@"VMAD\ScriptFragments\SceneScript\TargetRef", row.FieldPath);
        Assert.Equal("scen", row.RecordType);
    }

    [Fact]
    public void Index_DialogInfoFragmentScriptObjectProperty_IsIndexedInFormReferences()
    {
        FormKey targetFormKey = default;
        FormKey responseFormKey = default;

        using var fixture = new PluginFixtureBuilder("form-refs-info-fragment-script")
            .WithPlugin("InfoFragmentScript.esp", mod =>
            {
                targetFormKey = mod.Npcs.AddNew("InfoFragmentTarget").FormKey;
                var quest = mod.Quests.AddNew("InfoOwnerQuest");
                var topic = new DialogTopic(mod) { EditorID = "FragmentTopic" };
                quest.DialogTopics.Add(topic);
                var response = new DialogResponses(mod) { EditorID = "FragmentResponse" };
                responseFormKey = response.FormKey;
                response.VirtualMachineAdapter = new DialogResponsesAdapter
                {
                    ScriptFragments = new ScriptFragments
                    {
                        Script = ScriptWithObjectProperty("InfoScript", "TargetRef", targetFormKey),
                    },
                };
                topic.Responses.Add(response);
            })
            .Build();

        using var repo = IndexOnly(fixture, "InfoFragmentScript.esp");

        var row = Assert.Single(ReferencesTo(repo, targetFormKey));
        Assert.Equal(responseFormKey.ToString(), row.Source);
        Assert.Equal(@"VMAD\ScriptFragments\InfoScript\TargetRef", row.FieldPath);
        Assert.Equal("info", row.RecordType);
    }

    // AC4: an adapter-reachable script's properties are walked to the same depth top-level scripts
    // already are — nested struct members and struct-list members included. One test covers both
    // shapes on one alias script, so a partial walk (struct but not struct-list, or one level of
    // nesting only) fails here rather than passing three-quarters of a suite.
    [Fact]
    public void Index_QuestAliasScriptNestedStructMembers_AreWalkedToFullDepth()
    {
        FormKey nestedTarget = default;
        FormKey listTarget = default;
        FormKey questFormKey = default;

        using var fixture = new PluginFixtureBuilder("form-refs-quest-alias-nested")
            .WithPlugin("QuestAliasNested.esp", mod =>
            {
                nestedTarget = mod.Npcs.AddNew("NestedTarget").FormKey;
                listTarget = mod.Npcs.AddNew("ListTarget").FormKey;
                var quest = mod.Quests.AddNew("NestedAliasQuest");
                questFormKey = quest.FormKey;

                var script = new ScriptEntry { Name = "AliasScript", Flags = ScriptEntry.Flag.Local };

                // Struct → Struct → Object
                var outer = new ScriptStructProperty { Name = "Config" };
                var outerWrapper = new ScriptEntry();
                var inner = new ScriptStructProperty { Name = "Inner" };
                var innerWrapper = new ScriptEntry();
                var innerObj = new ScriptObjectProperty { Name = "DeepRef", Alias = -1 };
                innerObj.Object.SetTo(nestedTarget);
                innerWrapper.Properties.Add(innerObj);
                inner.Members.Add(innerWrapper);
                outerWrapper.Properties.Add(inner);
                outer.Members.Add(outerWrapper);
                script.Properties.Add(outer);

                // ArrayOfStruct → Object
                var structList = new ScriptStructListProperty { Name = "Parts" };
                var instance = new ScriptEntryStructs();
                var listObj = new ScriptObjectProperty { Name = "PartRef", Alias = -1 };
                listObj.Object.SetTo(listTarget);
                instance.Members.Add(listObj);
                structList.Structs.Add(instance);
                script.Properties.Add(structList);

                var alias = new QuestFragmentAlias();
                alias.Scripts.Add(script);
                var adapter = new QuestAdapter();
                adapter.Aliases.Add(alias);
                quest.VirtualMachineAdapter = adapter;
            })
            .Build();

        using var repo = IndexOnly(fixture, "QuestAliasNested.esp");

        var nestedRow = Assert.Single(ReferencesTo(repo, nestedTarget));
        Assert.Equal(questFormKey.ToString(), nestedRow.Source);
        Assert.Equal(@"VMAD\Aliases[0]\AliasScript\Config\Inner\DeepRef", nestedRow.FieldPath);

        var listRow = Assert.Single(ReferencesTo(repo, listTarget));
        Assert.Equal(questFormKey.ToString(), listRow.Source);
        Assert.Equal(@"VMAD\Aliases[0]\AliasScript\Parts[0]\PartRef", listRow.FieldPath);
    }
}
