using System.Text.RegularExpressions;
using MEditService.Core.Queries;
using MEditService.Core.Schema;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;

namespace MEditService.Tests.Schema;

/// <summary>The metadata describes the codec document by Mutagen's own names: every field a
/// declared property, every discriminator the document's MutagenObjectType, a type-varying member
/// one field with a variant per leaf (ADR-0032).</summary>
public sealed class DocumentWireSchemaTests
{
    private static readonly IReadOnlyDictionary<string, RecordTableSchema> Schemas =
        SharedSchemaReflector.Instance.GetSchemas(GameRelease.Fallout4);

    // Mutagen's own spelling: PascalCase, with an underscore only where Mutagen wrote one (EdgeLink_0_1).
    private static readonly Regex MutagenPropertyName = new("^[A-Z][A-Za-z0-9_]*$", RegexOptions.Compiled);

    private static readonly string[] LeafKinds =
        ["bool", "int", "float", "string", "translatedString", "hex", "color", "vector", "enum", "flags", "formKey", "struct", "array"];

    private static IEnumerable<(string Path, FieldMetadata Meta)> AllFields()
    {
        foreach (var (table, schema) in Schemas)
            foreach (var column in schema.RecordColumns)
                foreach (var found in Walk($"{table}.{column.Name}", column.ToFieldMetadata()))
                    yield return found;
    }

    private static IEnumerable<(string, FieldMetadata)> Walk(string path, FieldMetadata meta)
    {
        yield return (path, meta);
        if (meta.ElementType != null)
            foreach (var f in Walk(path + "[]", meta.ElementType)) yield return f;
        foreach (var sub in meta.Fields ?? [])
            foreach (var f in Walk($"{path}.{sub.Name}", sub)) yield return f;
        foreach (var (leaf, variant) in meta.Variants ?? new Dictionary<string, FieldMetadata>())
            foreach (var f in Walk($"{path}<{leaf}>", variant)) yield return f;
    }

    private static FieldMetadata Column(string table, string name) =>
        Schemas[table].RecordColumns.Single(c => c.Name == name).ToFieldMetadata();

    private static FieldMetadata Member(FieldMetadata owner, string name) => owner.Fields!.Single(f => f.Name == name);

    [Fact]
    public void EveryFieldName_IsAMutagenPropertyName()
    {
        var offenders = AllFields()
            .Where(f => f.Meta.Name.Length > 0 && !MutagenPropertyName.IsMatch(f.Meta.Name))
            .Select(f => f.Path)
            .ToList();

        Assert.Empty(offenders);
    }

    [Fact]
    public void EveryLeaf_IsNamedByAKindTheDocumentSpells()
    {
        var offenders = AllFields().Where(f => !LeafKinds.Contains(f.Meta.Type)).Select(f => $"{f.Path}: {f.Meta.Type}").ToList();

        Assert.Empty(offenders);
    }

    [Theory]
    [InlineData("kywd", "Color", "color")]
    [InlineData("refr", "Position", "vector")]
    [InlineData("npc_", "Name", "translatedString")]
    [InlineData("gras", "Unknown3", "hex")]
    [InlineData("npc_", "Flags", "flags")]
    [InlineData("npc_", "Aggression", "enum")]
    public void ALeafEncodingTheCodecOwns_IsNamedByItsKind(string table, string column, string kind) =>
        Assert.Equal(kind, Column(table, column).Type);

    [Fact]
    public void EveryDiscriminator_IsTheDocumentsOwnObjectTypeMember_WithAClosedLabelledDomain()
    {
        var discriminators = AllFields().Where(f => f.Meta.IsDiscriminator).ToList();

        Assert.NotEmpty(discriminators);
        Assert.All(discriminators, d =>
        {
            Assert.Equal("MutagenObjectType", d.Meta.Name);
            Assert.Equal("enum", d.Meta.Type);
            Assert.NotEmpty(d.Meta.EnumMembers);
            Assert.All(d.Meta.EnumMembers, m => Assert.False(string.IsNullOrWhiteSpace(m.Label)));
        });
    }

    [Theory]
    [InlineData("cobj", "Conditions", "[]")]
    [InlineData("cobj", "Conditions", "[]", "Data")]
    [InlineData("npc_", "Level")]
    [InlineData("qust", "Aliases", "[]")]
    [InlineData("npc_", "VirtualMachineAdapter", "Scripts", "[]", "Properties", "[]")]
    [InlineData("omod", "Properties", "[]")]
    public void EveryUnion_CarriesTheDocumentsDiscriminator(string table, params string[] hops)
    {
        var meta = Column(table, hops[0]);
        foreach (var hop in hops.Skip(1)) meta = hop == "[]" ? meta.ElementType! : Member(meta, hop);

        var discriminator = Assert.Single(meta.Fields!, f => f.IsDiscriminator);
        Assert.Equal("MutagenObjectType", discriminator.Name);
    }

    // A table backed by several record classes is a union at the record level, and its document
    // names its class first like any union element's does.
    [Theory]
    [InlineData("gmst", "GameSettingFloat")]
    [InlineData("glob", "GlobalFloat")]
    [InlineData("dmgt", "DamageTypeIndexed")]
    [InlineData("omod", "ArmorModification")]
    public void ATableOfSeveralRecordClasses_CarriesTheDocumentsDiscriminatorAsAColumn(string table, string leaf)
    {
        var discriminator = Column(table, "MutagenObjectType");

        Assert.True(discriminator.IsDiscriminator);
        Assert.Contains(leaf, discriminator.EnumMembers.Select(m => m.Value));
    }

    [Fact]
    public void ConditionComparisonValue_IsOneMemberWithAVariantPerLeaf()
    {
        var comparison = Member(Column("cobj", "Conditions").ElementType!, "ComparisonValue");

        Assert.Equal("float", comparison.Variants![nameof(ConditionFloat)].Type);
        Assert.Equal("formKey", comparison.Variants[nameof(ConditionGlobal)].Type);
        Assert.DoesNotContain(Column("cobj", "Conditions").ElementType!.Fields!, f => f.Name.Contains('_'));
    }

    [Fact]
    public void ScriptPropertyData_IsOneMemberWithAVariantPerLeaf()
    {
        var property = Member(Member(Column("npc_", "VirtualMachineAdapter"), "Scripts").ElementType!, "Properties").ElementType!;
        var data = Member(property, "Data");

        Assert.Equivalent(new Dictionary<string, string>
        {
            [nameof(ScriptIntProperty)] = "int",
            [nameof(ScriptFloatProperty)] = "float",
            [nameof(ScriptBoolProperty)] = "bool",
            [nameof(ScriptStringProperty)] = "string",
            [nameof(ScriptIntListProperty)] = "int[]",
            [nameof(ScriptFloatListProperty)] = "float[]",
            [nameof(ScriptBoolListProperty)] = "bool[]",
            [nameof(ScriptStringListProperty)] = "string[]",
            [nameof(ScriptVariableProperty)] = "int",
            [nameof(ScriptVariableListProperty)] = "int[]",
        }, data.Variants!.ToDictionary(v => v.Key, v => v.Value.IsArray ? v.Value.ElementType!.Type + "[]" : v.Value.Type), strict: true);
        Assert.Single(property.Fields!, f => f.Name == "Data");
    }

    [Fact]
    public void ObjectModPropertyValue_IsOneMemberWithAVariantPerLeaf_SpelledAsTheCodecSpellsTheLeaf()
    {
        var value = Member(Column("omod", "Properties").ElementType!, "Value");

        Assert.Contains("ObjectModIntProperty<Armor+Property>", value.Variants!.Keys);
        Assert.Equal("int", value.Variants["ObjectModIntProperty<Armor+Property>"].Type);
        Assert.Equal("float", value.Variants["ObjectModFloatProperty<Armor+Property>"].Type);
    }

    [Fact]
    public void GameSettingData_IsOneColumnWithAVariantPerRecordClass()
    {
        var data = Column("gmst", "Data");

        Assert.Equal("float", data.Variants![nameof(GameSettingFloat)].Type);
        Assert.Equal("int", data.Variants[nameof(GameSettingInt)].Type);
        Assert.Equal("translatedString", data.Variants[nameof(GameSettingString)].Type);
        Assert.Equal("bool", data.Variants[nameof(GameSettingBool)].Type);
    }

    [Fact]
    public void DamageTypes_IsOneColumnWithAVariantPerRecordClass()
    {
        var damageTypes = Column("dmgt", "DamageTypes");

        Assert.Equal("struct", damageTypes.Variants![nameof(DamageType)].ElementType!.Type);
        Assert.Equal("int", damageTypes.Variants[nameof(DamageTypeIndexed)].ElementType!.Type);
        Assert.DoesNotContain(Schemas["dmgt"].RecordColumns, c => c.Name != "DamageTypes" && c.Name.Contains("Damage", StringComparison.Ordinal));
    }

    [Fact]
    public void AVariantMap_IsKeyedByTheDiscriminatorsOwnDomain()
    {
        var offenders = new List<string>();
        foreach (var (path, meta) in AllFields())
        {
            if (meta.Fields is not { } fields) continue;
            var domain = fields.SingleOrDefault(f => f.IsDiscriminator)?.EnumMembers.Select(m => m.Value).ToHashSet(StringComparer.Ordinal);
            foreach (var field in fields.Where(f => f.Variants != null))
            {
                if (domain == null) { offenders.Add($"{path}.{field.Name}: variants with no discriminator beside them"); continue; }
                foreach (var key in field.Variants!.Keys.Where(k => !domain.Contains(k)))
                    offenders.Add($"{path}.{field.Name}: variant {key} names no leaf of the union");
            }
        }

        Assert.Empty(offenders);
    }
}
