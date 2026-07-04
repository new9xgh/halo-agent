/**
 * Halo on Amazon Bedrock AgentCore Runtime — one-shot deploy stack.
 *
 * Provisions:
 *   - Docker image build & push (CDK container asset → bootstrap ECR repo)
 *   - VPC: public subnets (NAT gateway) + private subnets (runtime + EFS)
 *   - EFS access point — persistent workspace mounted at /mnt/workspace
 *   - IAM execution role (ECR pull, logs, Bedrock model invocation, EFS)
 *   - AgentCore Runtime (container, ARM64, port 8080) in the VPC
 *   - S3 (private, OAC) + CloudFront hosting the demo frontend
 *
 * Network layout:
 *   - Runtime lives in PRIVATE_WITH_EGRESS subnets — outbound traffic
 *     (Bedrock API :443, npm, external APIs) goes through the NAT gateway.
 *     The NAT gives a stable egress IP; attach an Elastic IP to it if a
 *     downstream service needs an IP allowlist.
 *   - EFS mount targets are created per-AZ in the same private subnets;
 *     the file system SG only accepts :2049 from the runtime SG.
 *
 * Custom domain / access control are deliberately left to the operator:
 * pass `domainName` + `certificateArn` (us-east-1 ACM cert) via CDK context
 * to attach a custom domain, and add WAF / Cognito / etc. on top of the
 * distribution as your org requires. With no context set, the stack works
 * out of the box on the default CloudFront domain.
 *
 * NOTE the browser does NOT talk to the AgentCore endpoint unauthenticated:
 * AgentCore terminates auth (SigV4 / OAuth). Wire your auth flow to mint a
 * presigned / token-authenticated WS URL and inject it into the frontend as
 * `window.__CONFIG__ = { wsEndpoint: '...' }` (see index.html). The raw
 * runtime ARN is a backend-only output.
 */
import * as cdk from 'aws-cdk-lib'
import { Construct } from 'constructs'
import * as ec2 from 'aws-cdk-lib/aws-ec2'
import * as efs from 'aws-cdk-lib/aws-efs'
import * as iam from 'aws-cdk-lib/aws-iam'
import * as s3 from 'aws-cdk-lib/aws-s3'
import * as s3deploy from 'aws-cdk-lib/aws-s3-deployment'
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront'
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins'
import * as acm from 'aws-cdk-lib/aws-certificatemanager'
import * as agentcore from 'aws-cdk-lib/aws-bedrockagentcore'
import { DockerImageAsset, Platform } from 'aws-cdk-lib/aws-ecr-assets'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

export class HaloAgentCoreStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props)

    // Optional custom domain for the demo frontend:
    //   cdk deploy -c domainName=demo.example.com -c certificateArn=arn:aws:acm:us-east-1:...
    // (cert must live in us-east-1 — CloudFront requirement). Then point a
    // CNAME at the distribution domain. Unset → default CloudFront domain.
    const domainName = this.node.tryGetContext('domainName') as string | undefined
    const certificateArn = this.node.tryGetContext('certificateArn') as string | undefined

    // ── Container image: build packages/agentcore-demo/Dockerfile, push to
    //    the CDK bootstrap ECR repo. AgentCore runs ARM64.
    const image = new DockerImageAsset(this, 'HaloImage', {
      directory: path.join(__dirname, '..', '..'),
      platform: Platform.LINUX_ARM64,
    })

    // ── VPC: runtime + EFS live in private subnets; a single NAT gateway in
    //    the public subnet provides egress (Bedrock API, external APIs) with
    //    a stable source IP.
    const vpc = new ec2.Vpc(this, 'Vpc', {
      maxAzs: 2,
      natGateways: 1,
      subnetConfiguration: [
        { name: 'public', subnetType: ec2.SubnetType.PUBLIC, cidrMask: 24 },
        { name: 'private', subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS, cidrMask: 24 },
      ],
    })

    // Runtime SG: restrict outbound to what halo actually needs —
    // 443 (Bedrock / external APIs) + 2049 (EFS). Widen if your agents
    // must reach other ports (e.g. 80, git+ssh 22).
    const runtimeSg = new ec2.SecurityGroup(this, 'RuntimeSg', {
      vpc,
      description: 'Halo AgentCore runtime',
      allowAllOutbound: false,
    })
    runtimeSg.addEgressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(443), 'Bedrock + external HTTPS APIs')

    // ── EFS: permanent workspace storage. Unlike managed session storage this
    //    never expires — user workspaces survive across sessions/deploys.
    //    Mount targets land in the same private subnets (one per AZ).
    const fileSystem = new efs.FileSystem(this, 'Workspace', {
      vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      encrypted: true,
      performanceMode: efs.PerformanceMode.GENERAL_PURPOSE,
      throughputMode: efs.ThroughputMode.ELASTIC,
      // POC default: destroy with the stack. Switch to RETAIN for real data.
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    })
    // EFS SG ← :2049 from runtime SG only; the reverse rule (runtime → :2049)
    // is added on runtimeSg by the connections helper.
    fileSystem.connections.allowDefaultPortFrom(runtimeSg, 'NFS from Halo runtime')

    const accessPoint = fileSystem.addAccessPoint('WorkspaceAp', {
      path: '/halo-workspace',
      createAcl: { ownerUid: '1000', ownerGid: '1000', permissions: '750' },
      posixUser: { uid: '1000', gid: '1000' },
    })

    // ── Execution role — AgentCore assumes this to pull the image, write
    //    logs, call Bedrock models, and mount EFS.
    const role = new iam.Role(this, 'RuntimeRole', {
      assumedBy: new iam.ServicePrincipal('bedrock-agentcore.amazonaws.com'),
    })
    image.repository.grantPull(role)
    role.addToPolicy(new iam.PolicyStatement({
      actions: ['logs:CreateLogGroup', 'logs:CreateLogStream', 'logs:PutLogEvents'],
      resources: ['*'],
    }))
    role.addToPolicy(new iam.PolicyStatement({
      // The halo agent calls Bedrock models via the runtime's credentials.
      actions: ['bedrock:InvokeModel', 'bedrock:InvokeModelWithResponseStream'],
      resources: ['*'],
    }))
    role.addToPolicy(new iam.PolicyStatement({
      actions: ['elasticfilesystem:ClientMount', 'elasticfilesystem:ClientWrite'],
      resources: [fileSystem.fileSystemArn],
    }))
    role.addToPolicy(new iam.PolicyStatement({
      // ECR auth token is account-scoped, not repo-scoped.
      actions: ['ecr:GetAuthorizationToken'],
      resources: ['*'],
    }))

    // ── AgentCore Runtime — VPC mode, private subnets, our SG.
    const runtime = new agentcore.Runtime(this, 'HaloRuntime', {
      runtimeName: 'halo_agentcore_demo',
      agentRuntimeArtifact: agentcore.AgentRuntimeArtifact.fromEcrRepository(image.repository, image.imageTag),
      executionRole: role,
      protocolConfiguration: agentcore.ProtocolType.HTTP,
      networkConfiguration: agentcore.RuntimeNetworkConfiguration.usingVpc(this, {
        vpc,
        vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
        securityGroups: [runtimeSg],
      }),
      environmentVariables: {
        HALO_RUNTIME_MODE: 'agentcore',
        HALO_PORT: '8080',
        HALO_WORKSPACE: '/mnt/workspace',
      },
    })
    runtime.node.addDependency(fileSystem)

    // EFS access point mount — persistent workspace (NOT managed session
    // storage, which expires with the session). The L2 Runtime construct
    // doesn't surface filesystemConfigurations yet, so set it on the
    // underlying CfnRuntime via the standard escape hatch.
    const cfnRuntime = runtime.node.defaultChild as agentcore.CfnRuntime
    cfnRuntime.filesystemConfigurations = [
      {
        efsAccessPoint: {
          accessPointArn: accessPoint.accessPointArn,
          mountPath: '/mnt/workspace',
        },
      },
    ]

    // ── Demo frontend: private S3 + CloudFront with Origin Access Control.
    const siteBucket = new s3.Bucket(this, 'DemoSite', {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    })

    const distribution = new cloudfront.Distribution(this, 'DemoCdn', {
      defaultBehavior: {
        origin: origins.S3BucketOrigin.withOriginAccessControl(siteBucket),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
      },
      defaultRootObject: 'index.html',
      ...(domainName && certificateArn
        ? {
            domainNames: [domainName],
            certificate: acm.Certificate.fromCertificateArn(this, 'DemoCert', certificateArn),
          }
        : {}),
    })

    new s3deploy.BucketDeployment(this, 'DeployDemo', {
      sources: [s3deploy.Source.asset(path.join(__dirname, '..', '..'), {
        exclude: ['*', '!index.html'],
      })],
      destinationBucket: siteBucket,
      distribution,
      distributionPaths: ['/*'],
    })

    // ── Outputs ──
    new cdk.CfnOutput(this, 'DemoUrl', {
      value: `https://${domainName ?? distribution.distributionDomainName}`,
      description: 'Demo frontend (CloudFront). Open in a browser.',
    })
    new cdk.CfnOutput(this, 'CloudFrontDistributionId', {
      value: distribution.distributionId,
      description: 'For attaching a custom domain / WAF later.',
    })
    new cdk.CfnOutput(this, 'AgentRuntimeArn', {
      value: runtime.agentRuntimeArn,
      description: 'Backend/SDK use only — do NOT embed in the browser frontend.',
    })
    new cdk.CfnOutput(this, 'AgentCoreWsEndpoint', {
      // URL-encode the ARN when substituting into the path. The browser needs
      // an authenticated variant of this URL (presigned / OAuth token) — mint
      // it from your backend and inject as window.__CONFIG__.wsEndpoint.
      value: `wss://bedrock-agentcore.${this.region}.amazonaws.com/runtimes/<url-encoded-runtime-arn>/ws`,
      description: 'AgentCore WS endpoint template for the frontend config.',
    })
  }
}
