namespace MEditService.Architecture.Tests;

public sealed class ComparisonDoorBoundaryTests
{
    [Fact]
    public void GeneratedEqualityMask_IsOnlyConsultedByModelIdentity_BecauseMutagensGeneratedComparersLieInBothDirections()
    {
        var offenders = ServiceProjects.Production(ServiceProjects.SolutionDirectory())
            .Select(project => ServiceProjects.Folder(ServiceProjects.SolutionDirectory(), project))
            .SelectMany(ScanForMaskConsultation)
            .ToList();

        Assert.Empty(offenders);
    }

    private static IEnumerable<string> ScanForMaskConsultation(string projectRoot)
    {
        return Directory.EnumerateFiles(projectRoot, "*.cs", SearchOption.AllDirectories)
            .Where(f => !Path.GetFileName(f).Equals("ModelIdentity.cs", StringComparison.Ordinal))
            .Where(f => !f.Contains($"{Path.DirectorySeparatorChar}obj{Path.DirectorySeparatorChar}", StringComparison.Ordinal))
            .Where(f =>
            {
                var text = File.ReadAllText(f);
                return text.Contains("GetEqualsMask", StringComparison.Ordinal)
                    || text.Contains("EqualsMaskHelper", StringComparison.Ordinal);
            })
            .Select(Path.GetFileName)
            .OfType<string>();
    }
}
