using System.Text.RegularExpressions;
using MEditService.Codec.Schema;
using MEditService.TestSupport;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;

namespace MEditService.Codec.Tests.Schema;

/// <summary>The metadata describes the codec document by Mutagen's own names: every field a
/// declared property, every discriminator the document's MutagenObjectType, a type-varying member
/// one field with a variant per leaf (ADR-0005).</summary>
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

    private static FieldMetadata Member(FieldMetadata owner, string name) => RequireFields(owner).Single(f => f.Name == name);

    private static IReadOnlyList<FieldMetadata> RequireFields(FieldMetadata meta) =>
        meta.Fields ?? throw new InvalidOperationException($"Expected '{meta.Name}' to have fields.");

    private static FieldMetadata RequireElementType(FieldMetadata meta) =>
        meta.ElementType ?? throw new InvalidOperationException($"Expected '{meta.Name}' to have an element type.");

    private static IReadOnlyDictionary<string, FieldMetadata> RequireVariants(FieldMetadata meta) =>
        meta.Variants ?? throw new InvalidOperationException($"Expected '{meta.Name}' to have variants.");

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
        foreach (var hop in hops.Skip(1)) meta = hop == "[]" ? RequireElementType(meta) : Member(meta, hop);

        var discriminator = Assert.Single(RequireFields(meta), f => f.IsDiscriminator);
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
        var conditionElement = RequireElementType(Column("cobj", "Conditions"));
        var comparison = Member(conditionElement, "ComparisonValue");
        var variants = RequireVariants(comparison);

        Assert.Equal("float", variants[nameof(ConditionFloat)].Type);
        Assert.Equal("formKey", variants[nameof(ConditionGlobal)].Type);
        Assert.DoesNotContain(RequireFields(conditionElement), f => f.Name.Contains('_'));
    }

    [Fact]
    public void ScriptPropertyData_IsOneMemberWithAVariantPerLeaf()
    {
        var scriptElement = RequireElementType(Member(Column("npc_", "VirtualMachineAdapter"), "Scripts"));
        var property = RequireElementType(Member(scriptElement, "Properties"));
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
        }, RequireVariants(data).ToDictionary(v => v.Key, v => v.Value.IsArray ? RequireElementType(v.Value).Type + "[]" : v.Value.Type), strict: true);
        Assert.Single(RequireFields(property), f => f.Name == "Data");
    }

    [Fact]
    public void ObjectModPropertyValue_IsOneMemberWithAVariantPerLeaf_SpelledAsTheCodecSpellsTheLeaf()
    {
        var value = Member(RequireElementType(Column("omod", "Properties")), "Value");
        var variants = RequireVariants(value);

        Assert.Contains("ObjectModIntProperty<Armor+Property>", variants.Keys);
        Assert.Equal("int", variants["ObjectModIntProperty<Armor+Property>"].Type);
        Assert.Equal("float", variants["ObjectModFloatProperty<Armor+Property>"].Type);
    }

    [Fact]
    public void GameSettingData_IsOneColumnWithAVariantPerRecordClass()
    {
        var data = Column("gmst", "Data");
        var variants = RequireVariants(data);

        Assert.Equal("float", variants[nameof(GameSettingFloat)].Type);
        Assert.Equal("int", variants[nameof(GameSettingInt)].Type);
        Assert.Equal("translatedString", variants[nameof(GameSettingString)].Type);
        Assert.Equal("bool", variants[nameof(GameSettingBool)].Type);
    }

    [Fact]
    public void DamageTypes_IsOneColumnWithAVariantPerRecordClass()
    {
        var damageTypes = Column("dmgt", "DamageTypes");
        var variants = RequireVariants(damageTypes);

        Assert.Equal("struct", RequireElementType(variants[nameof(DamageType)]).Type);
        Assert.Equal("int", RequireElementType(variants[nameof(DamageTypeIndexed)]).Type);
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
            foreach (var field in fields)
            {
                if (field.Variants is not { } variants) continue;
                if (domain == null) { offenders.Add($"{path}.{field.Name}: variants with no discriminator beside them"); continue; }
                foreach (var key in variants.Keys.Where(k => !domain.Contains(k)))
                    offenders.Add($"{path}.{field.Name}: variant {key} names no leaf of the union");
            }
        }

        Assert.Empty(offenders);
    }
}
