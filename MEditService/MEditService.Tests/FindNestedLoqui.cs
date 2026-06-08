#pragma warning disable CA1310, CA1860
using System;
using System.Linq;
using System.Reflection;
using Mutagen.Bethesda.Fallout4;
using Xunit;

namespace MEditService.Tests;

public class FindNestedLoquiTest
{
    [Fact]
    public void PrintAllListPropertiesWithLoquiElements()
    {
        var asm = typeof(Npc).Assembly;
        var getterTypes = asm.GetTypes()
            .Where(t => t.Name.EndsWith("Getter") && t.IsInterface)
            .OrderBy(t => t.Name)
            .ToList();

        Console.WriteLine($"Checking {getterTypes.Count} Getter types...");

        int foundCount = 0;
        foreach (var getterType in getterTypes)
        {
            var props = getterType.GetProperties(BindingFlags.Public | BindingFlags.Instance);

            foreach (var prop in props)
            {
                var propType = prop.PropertyType;

                // Check if it's an IReadOnlyList<T>
                if (!propType.IsGenericType) continue;
                var genDef = propType.GetGenericTypeDefinition();
                if (genDef.Name != "IReadOnlyList`1") continue;

                var elemType = propType.GetGenericArguments()[0];

                // Check if element type is a Loqui (ends with Getter)
                if (!elemType.Name.EndsWith("Getter")) continue;

                // Now check if that Loqui element type has properties that are themselves Loqui interfaces
                var elemProps = elemType.GetProperties(BindingFlags.Public | BindingFlags.Instance);
                var nestedLoquiProps = elemProps.Where(p =>
                    p.PropertyType.IsInterface &&
                    p.PropertyType.Name.EndsWith("Getter") &&
                    !p.PropertyType.Name.Contains("FormLink") &&
                    p.PropertyType.Name != "IKeywordGetter"
                ).ToList();

                if (nestedLoquiProps.Count > 0)
                {
                    foundCount++;
                    Console.WriteLine($"FOUND #{foundCount}: {getterType.Name}.{prop.Name}");
                    Console.WriteLine($"  List element type: {elemType.Name}");
                    Console.WriteLine($"  Nested Loqui properties:");
                    foreach (var nProp in nestedLoquiProps)
                    {
                        Console.WriteLine($"    - {nProp.Name}: {nProp.PropertyType.Name}");
                    }
                    Console.WriteLine();
                }
            }
        }

        if (foundCount == 0)
        {
            Console.WriteLine("No nested Loqui-in-Loqui-in-list found.");
        }
        else
        {
            Console.WriteLine($"Found {foundCount} examples total.");
        }

        // Dummy assertion to keep xunit happy
        Assert.True(true);
    }
}
