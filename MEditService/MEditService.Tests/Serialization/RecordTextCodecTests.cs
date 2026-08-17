using System.Reflection;
using MEditService.Core.Serialization;
using Microsoft.Extensions.Logging.Abstractions;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;
using Noggog;

namespace MEditService.Tests.Serialization;

public class RecordTextCodecTests
{
    private static Weapon MakeWeapon() =>
        new(new FormKey(ModKey.FromFileName("Test.esp"), 0x800), Fallout4Release.Fallout4)
        {
            VersionControl = 12345,
            EditorID = "TestWeapon",
            Name = "Test Weapon Name",
            Value = 250,
            Weight = 12.5f,
            BaseDamage = 42,
            Keywords = [new FormLink<IKeywordGetter>(new FormKey(ModKey.FromFileName("Test.esp"), 0x801))],
            ObjectBounds = new ObjectBounds
            {
                First = new P3Int16(1, 2, 3),
                Second = new P3Int16(4, 5, 6),
            },
        };

    // No exclusion list: verified empirically (#367 report) that .OmitLastModifiedData()/
    // .OmitTimestampData() are no-ops for a standalone Weapon — the serialized YAML is
    // byte-identical with and without them. Both customizations are about mod/header-level
    // metadata (Spriggit's own scope), which this codec never touches; VersionControl (the field
    // that could plausibly be "the timestamp" on a record) round-trips like everything else, which
    // is why this test asserts every field equal with no exceptions.
    [Fact]
    public async Task SerializeAsync_ThenDeserializeAsync_IsFieldFaithful()
    {
        var codec = new RecordTextCodec(NullLogger<RecordTextCodec>.Instance);
        var original = MakeWeapon();
        var dir = Directory.CreateTempSubdirectory("medit-codec-fidelity-");
        try
        {
            var filePath = Path.Combine(dir.FullName, "weapon.yaml");
            await codec.SerializeAsync(original, filePath);

            var roundTripped = await codec.DeserializeAsync(filePath);

            var mask = original.GetEqualsMask(roundTripped);
            var divergent = FindDivergentFields(mask, "").ToList();

            Assert.Empty(divergent);
        }
        finally
        {
            dir.Delete(recursive: true);
        }
    }

    // Walks a Mutagen-generated Mask<bool> object graph (Loqui's MaskItem<Overall, Specific>
    // wrappers, indexed collections, and plain bool leaves) and returns the dotted field path of
    // every leaf that is `false` (unequal). Test-only — production code never needs this; Mutagen
    // generates the mask, this just makes a failure legible instead of a bare "objects differ".
    private static IEnumerable<string> FindDivergentFields(object? node, string path)
    {
        switch (node)
        {
            case null:
                yield break;
            case bool b:
                if (!b)
                {
                    yield return path;
                }
                yield break;
        }

        var type = node.GetType();

        if (type.GetField("Overall") is { } overallField && type.GetField("Specific") is { } specificField)
        {
            foreach (var f in FindDivergentFields(overallField.GetValue(node), path))
            {
                yield return f;
            }

            foreach (var f in FindDivergentFields(specificField.GetValue(node), path))
            {
                yield return f;
            }

            yield break;
        }

        if (node is System.Collections.IEnumerable enumerable and not string)
        {
            var i = 0;
            foreach (var element in enumerable)
            {
                var elementType = element?.GetType();
                if (elementType is { IsGenericType: true } && elementType.GetGenericTypeDefinition() == typeof(ValueTuple<,>))
                {
                    var idx = elementType.GetField("Item1")!.GetValue(element);
                    var val = elementType.GetField("Item2")!.GetValue(element);
                    foreach (var f in FindDivergentFields(val, $"{path}[{idx}]"))
                    {
                        yield return f;
                    }
                }
                else
                {
                    foreach (var f in FindDivergentFields(element, $"{path}[{i}]"))
                    {
                        yield return f;
                    }
                }

                i++;
            }

            yield break;
        }

        foreach (var field in type.GetFields(BindingFlags.Public | BindingFlags.Instance))
        {
            var childPath = path.Length == 0 ? field.Name : $"{path}.{field.Name}";
            foreach (var f in FindDivergentFields(field.GetValue(node), childPath))
            {
                yield return f;
            }
        }

        foreach (var prop in type.GetProperties(BindingFlags.Public | BindingFlags.Instance))
        {
            if (prop.GetIndexParameters().Length > 0)
            {
                continue;
            }

            var childPath = path.Length == 0 ? prop.Name : $"{path}.{prop.Name}";
            foreach (var f in FindDivergentFields(prop.GetValue(node), childPath))
            {
                yield return f;
            }
        }
    }

    [Fact]
    public async Task SerializeAsync_WritesOneFileAtTheGivenPath()
    {
        var codec = new RecordTextCodec(NullLogger<RecordTextCodec>.Instance);
        var weapon = MakeWeapon();
        var dir = Directory.CreateTempSubdirectory("medit-codec-layout-");
        try
        {
            var filePath = Path.Combine(dir.FullName, "weapon.yaml");

            await codec.SerializeAsync(weapon, filePath);

            Assert.True(File.Exists(filePath));
            Assert.Equal([filePath], Directory.GetFiles(dir.FullName, "*", SearchOption.AllDirectories));
        }
        finally
        {
            dir.Delete(recursive: true);
        }
    }
}
